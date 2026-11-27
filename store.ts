/**
 * 基于 SQLite 驱动的持久化记忆存储层，底层使用 Bun 原生的 bun:sqlite。
 *
 * 移植自 pi-memory (https://github.com/samfoy/pi-memory)。
 * 数据库包含四张核心表:
 * - semantic: 键值对形式的事实记忆 (偏好设置、项目级开发模式、工具偏好)
 * - lessons: 学习到的经验教训，包含去重机制 (基于 Jaccard 相似度)
 * - events: 审计日志表，记录所有的记忆读写操作
 * - semantic_history: 覆盖写留下的旧值（只追加；遗忘时清空）
 *
 * 默认尝试使用 FTS5 引擎进行全文搜索；如果环境不支持 FTS5，则自动降级使用 LIKE 模糊匹配。
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ─── 类型定义 ───────────────────────────────────────────────────────────

export interface SemanticEntry {
  /** 记忆的键名，通常包含点号前缀用于分组 (如 pref.code_style) */
  key: string;
  /** 记忆的值内容 */
  value: string;
  /** 置信度 (0-1)，代表该记忆的准确程度 */
  confidence: number;
  /** 记忆的来源: user (用户指定) | consolidation (后台整合) | correction (AI纠错) */
  source: "user" | "consolidation" | "correction";
  /** 创建时间的 ISO 字符串 */
  created_at: string;
  /** 最后一次更新的 ISO 字符串 */
  updated_at: string;
  /** 最后一次访问的 ISO 字符串 (可选) */
  last_accessed?: string;
  /**
   * 项目标识符 (Git 远程仓库 URL 或本地格式化路径)。
   * 如果是全局记忆则该值为 null。
   */
  project: string | null;
  /** 被哪条记录取代（整合后的指向）；null 表示仍是有效记录 */
  superseded_by: string | null;
}

export interface LessonEntry {
  /** 教训的唯一 UUID */
  id: string;
  /** 教训的具体规则描述 */
  rule: string;
  /** 类别分类 (例如 'git', 'coding') */
  category: string;
  /** 来源 */
  source: string;
  /** 是否是反面教材（需要 AVOID 避免的，而非 DO 推荐的） */
  negative: boolean;
  /** 创建时间的 ISO 字符串 */
  created_at: string;
  /** 该教训提取时所在的项目标识，全局教训则为 null */
  project: string | null;
  /** 被哪条教训取代（整合后的指向）；null 表示仍是有效记录 */
  superseded_by: string | null;
}

export interface MemoryEvent {
  /** 递增的主键 ID */
  id: number;
  /** 事件类型 (例如 'upsert', 'delete') */
  event_type: string;
  /** 记忆类型 ('semantic' 或 'lesson') */
  memory_type: string;
  /** 受影响的记忆键名或教训 ID */
  memory_key: string;
  /** 详细的修改内容日志 */
  details: string;
  /** 发生时间的 ISO 字符串 */
  created_at: string;
}

export interface MemoryStats {
  /** 事实记忆总数（含已被取代的） */
  semanticCount: number;
  /** 经验教训总数（含已被取代的） */
  lessonCount: number;
  /** 事件日志总数 */
  eventCount: number;
  /** 已被整合取代的事实条数（不参与注入） */
  semanticSuperseded: number;
  /** 已被整合取代的教训条数（不参与注入） */
  lessonSuperseded: number;
}

/** 一次整合动作：保留 keep，把 drop 合并进来 */
export interface ConsolidationGroup {
  kind: "fact" | "lesson";
  /** 保留条目的标识：facts 用 key，lessons 用 id */
  keep: string;
  /** 保留条目的原内容（facts 是 value，lessons 是 rule），便于报告与留档 */
  keep_text: string;
  /** 被并掉的条目标识 */
  drop: string[];
  /** 合并后的内容；与 keep_text 相同说明对方没有带来新信息 */
  merged: string;
  /** 组内最高相似度（0-1），便于人工判断这次合并该不该做 */
  similarity: number;
  /** 作用域：facts 用它定位到具体那一行（全局 vs 某个项目） */
  scope: string | null;
}

// ─── 杰卡德相似度 (Jaccard Similarity) 算法 ──────────────────────────────────────────────

/**
 * 把文本拆成用于相似度比较的 token 集合。
 *
 * - 拉丁字母/数字按词切分。
 * - CJK 没有空格，按「二元组」切分（部署前 → 部署/署前…），单字成串时保留单字。
 *   注意不能用 `\w` 过滤后按空格切：`\w` 不含中文，纯中文句会变成空集，
 *   导致任意两条中文教训都被判成完全重复而拒收。
 */
function tokenizeForSimilarity(s: string): Set<string> {
  const lower = s.toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    tokens.add(m[0]);
  }
  for (const m of lower.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 计算两个字符串的 Token 级 Jaccard 相似度。
 * 主要用于经验教训的去重拦截 — 如果相似度 >= 0.7，我们就会认为这是一条重复的教训。
 *
 * @param a 第一个需要比较的字符串
 * @param b 第二个需要比较的字符串
 * @returns {number} 相似度得分 (0.0 到 1.0)
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenizeForSimilarity(a);
  const setB = tokenizeForSimilarity(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 查询里是否含 CJK。含 CJK 时检索必须绕开 FTS：
 * FTS5 的 unicode61 把连续汉字整段当成一个 token（"部署前先预览" 是一个 token），
 * `MATCH '"部署"'` 因此对中文必然 0 命中。LIKE 子串匹配对中文有效，
 * 且对英文/ASCII 的命中结果与 FTS 一致（实测逐词对比无差异）。
 */
const HAS_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// ─── 整合 (Consolidation) 判定辅助 ──────────────────────────────────────────────

/** 自动整合默认阈值：只合并高度重复的条目，误合并的风险优先于覆盖率 */
export const DEFAULT_CONSOLIDATION_THRESHOLD = 0.9;

/** 合并后单条内容的上限：避免把一堆条目拼成一篇长文 */
const MERGE_MAX_CHARS = 600;

/** 包含关系判定的最小长度：太短的值（"中文"）包含匹配没有意义 */
const CONTAIN_MIN_CHARS = 12;

/** 归一化后用于比较：小写 + 折叠空白 */
function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 把「实例编号」归一化：数字、含数字的标识符（module_1、v20.11.0）、路径段都换成 `#`。
 * 用来识别「只差一个编号」的平行规则 —— 它们相似度往往 > 0.9，但讲的是不同对象，
 * 在写入期按相似度拒收就是误拒（module_1 的规则进不了库）。
 */
function normalizeIdentifiers(text: string): string {
  return text
    .replace(/[a-z0-9_./\\-]*\d[a-z0-9_./\\-]*/gi, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 两条记忆是否在讲同一件事。
 *
 * 判定分两种口径：
 * - 事实（allowSimilarity=false）：只认「完全相同」和「一条是另一条的可靠子串」。
 *   两条高相似但各自带不同标识的条目（如 per-module 笔记只差一个编号）不是重复，
 *   用 Jaccard 合并它们就是误合并 —— 宁可漏掉，也不猜。
 * - 教训（allowSimilarity=true）：规则是散文，内容值得比较，允许 Jaccard 达阈值。
 */
function isSameMemory(
  a: string,
  b: string,
  threshold: number,
  allowSimilarity: boolean,
): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= CONTAIN_MIN_CHARS && longer.includes(shorter)) return true;

  return allowSimilarity && jaccardSimilarity(na, nb) >= threshold;
}

/** 按句读切成片段，用于「只补进对方独有的信息」 */
function splitFragments(text: string): string[] {
  return text
    .split(/[。；;!?！？\n]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * 合并内容：保留 base 的表述，只追加 extras 里「base 没有的片段」。
 * 判定新片段是否已有：子串包含，或与任一已有片段 Jaccard >= 0.75。
 * 这样相近的两条不会简单拼接成重复啰嗦的一段。
 */
function mergeTexts(base: string, extras: string[]): string {
  const kept = splitFragments(base);
  const originalCount = kept.length;
  for (const extra of extras) {
    for (const fragment of splitFragments(extra)) {
      const current = kept.join("；");
      if (current.includes(fragment)) continue;
      if (kept.some((k) => jaccardSimilarity(k, fragment) >= 0.75)) continue;
      if (current.length + fragment.length > MERGE_MAX_CHARS) {
        return kept.length === originalCount ? base : kept.join("；");
      }
      kept.push(fragment);
    }
  }
  // 没有新增内容时原样返回，避免只因为标点归一化就改写用户的表述
  return kept.length === originalCount ? base : kept.join("；");
}

/** 组内任意两对的最高相似度，给人看「这次合并有多激进」 */
function maxPairSimilarity(texts: string[]): number {
  let max = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = normalizeForCompare(texts[i]!);
      const b = normalizeForCompare(texts[j]!);
      const score =
        a === b || a.includes(b) || b.includes(a) ? 1 : jaccardSimilarity(a, b);
      if (score > max) max = score;
    }
  }
  return Math.round(max * 100) / 100;
}

/** 事实的保留条目：置信度高 > 内容更长（信息更多）> 新近 > 键名，保证结果稳定 */
function pickFactCanonical(cluster: SemanticEntry[]): SemanticEntry {
  return [...cluster].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.value.length - a.value.length ||
      b.updated_at.localeCompare(a.updated_at) ||
      a.key.localeCompare(b.key),
  )[0]!;
}

/** 教训的保留条目：规则最长（信息最多）> 最早创建 > id，保证结果稳定 */
function pickLessonCanonical(cluster: LessonEntry[]): LessonEntry {
  return [...cluster].sort(
    (a, b) =>
      b.rule.length - a.rule.length ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  )[0]!;
}

// ─── 数据库存储类 (Store) ───────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database;
  private hasFTS5: boolean = false;

  /**
   * 实例化内存数据库并运行迁移。
   *
   * @param dbPath 数据库文件存放的绝对路径
   */
  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed TEXT,
        project TEXT,
        UNIQUE(key, project)
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'user',
        negative INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        project TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // ── v2.3.0 迁移：整合（consolidation）相关 ──────────────────────
    // 加列必须幂等：老库重复启动时不能再 ALTER 一次（会报 duplicate column）
    this.addColumnIfMissing("semantic", "superseded_by", "TEXT");
    this.addColumnIfMissing("lessons", "superseded_by", "TEXT");

    // 覆盖写之前把旧值留档：否则 upsert 就是永久丢信息
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        project TEXT,
        replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_history_key
        ON semantic_history(key, replaced_at DESC);
    `);

    // v2.3.1 迁移：早期版本用 is_deleted 软删除，规则文本一直留在库里。
    // 这些教训是用户当时明确要求「忘掉」的，这里物理清掉并抹掉事件日志里的内容。
    // 新版 deleteLesson 已是硬删除，不会再产生这类行。
    const legacyDeleted = this.db
      .prepare(`SELECT id FROM lessons WHERE is_deleted = 1`)
      .all() as Array<{ id: string }>;
    if (legacyDeleted.length > 0) {
      const redactLegacy = this.db.prepare(
        `UPDATE events SET details = '[redacted]' WHERE memory_type = 'lesson' AND memory_key = ?`,
      );
      for (const row of legacyDeleted) redactLegacy.run(row.id);
      this.db.exec(`DELETE FROM lessons WHERE is_deleted = 1`);
    }

    // 创建用于全文搜索的 FTS5 虚拟表及触发器 (bun:sqlite 的部分环境可能不支持)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
          key, value, content='semantic', content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS semantic_ai AFTER INSERT ON semantic BEGIN
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_ad AFTER DELETE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_au AFTER UPDATE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
      `);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
          rule, category, content='lessons', content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
      `);

      this.hasFTS5 = true;
    } catch {
      // 环境不支持 FTS5 引擎，将会降级使用 LIKE 搜索
      this.hasFTS5 = false;
    }

    // 每次启动时如果支持 FTS5，就全量重建一次全文索引，确保虚拟表和真实表数据一致
    if (this.hasFTS5) {
      try {
        this.db.exec(
          `INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild')`,
        );
        this.db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')`);
      } catch {
        // 忽略重建过程中可能发生的错误
      }
    }
  }

  /** 幂等地补一列（老库升级用）：已存在就不动，避免 ALTER 报 duplicate column */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // ─── 事实记忆 (Semantic Memory) 操作 ─────────────────────────────────────────────

  /**
   * 搜索事实记忆，优先使用 FTS5 引擎；查询含 CJK 或 FTS5 不可用时走 LIKE 子串匹配。
   *
   * @param query 搜索关键词
   * @param limit 返回的最大条数 (默认 15)
   * @returns 匹配到的事实记忆数组
   */
  searchSemantic(query: string, limit: number = 15): SemanticEntry[] {
    if (!query.trim()) return [];

    // 含中文等 CJK 的查询绕开 FTS（unicode61 无法切分，MATCH 必然 0 命中）
    if (this.hasFTS5 && !HAS_CJK.test(query)) {
      try {
        // 针对 FTS5 引擎净化查询字符串 — 移除特殊字符并使用 OR 连接多个单词
        const sanitized = query
          .replace(/['"]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `"${w}"`)
          .join(" OR ");

        if (!sanitized) return this.searchSemanticFallback(query, limit);

        const stmt = this.db.prepare(`
          SELECT s.key, s.value, s.confidence, s.source, s.created_at, s.updated_at, s.last_accessed, s.project, s.superseded_by
          FROM semantic s
          JOIN semantic_fts f ON s.rowid = f.rowid
          WHERE semantic_fts MATCH ? AND s.superseded_by IS NULL
          ORDER BY rank
          LIMIT ?
        `);
        const results = stmt.all(sanitized, limit) as SemanticEntry[];

        // 成功返回前更新命中记录的 last_accessed 时间戳
        if (results.length > 0) {
          const updateStmt = this.db.prepare(
            `UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?`,
          );
          for (const r of results) {
            updateStmt.run(r.key);
          }
        }

        return results;
      } catch {
        return this.searchSemanticFallback(query, limit);
      }
    }

    return this.searchSemanticFallback(query, limit);
  }

  private searchSemanticFallback(
    query: string,
    limit: number,
  ): SemanticEntry[] {
    const words = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${w}%`);
    if (words.length === 0) return [];

    // 针对每个拆分后的词，构建 (key LIKE ? OR value LIKE ?) 的查询条件
    const conditions = words
      .map(() => `(key LIKE ? OR value LIKE ?)`)
      .join(" OR ");
    const params: (string | number)[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project, superseded_by
      FROM semantic
      WHERE superseded_by IS NULL AND (${conditions})
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const results = stmt.all(...params) as SemanticEntry[];

    // 更新访问时间
    if (results.length > 0) {
      const updateStmt = this.db.prepare(
        `UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?`,
      );
      for (const r of results) {
        updateStmt.run(r.key);
      }
    }

    return results;
  }

  /**
   * 插入或更新一条事实记忆记录。
   *
   * @param key 记忆的键名 (如 'user.timezone')
   * @param value 记忆的值 (如 'Asia/Shanghai')
   * @param confidence 置信度，代表记忆的准确性，0-1 之间 (默认 0.9)
   * @param source 来源标识符 (默认 'user')
   * @param project 项目标识符 (Git 远程 URL 或本地路径)，如果属于全局记忆请传入 null
   */
  upsertSemantic(
    key: string,
    value: string,
    confidence: number = 0.9,
    source: string = "user",
    project: string | null = null,
  ): void {
    // SQLite 中的 UNIQUE(key, project) 将 NULL 视为彼此不同，
    // 因此我们需要分别针对 全局作用域 (project IS NULL) 和 局部作用域 进行不同的插入与更新处理。
    const where =
      project === null ? `key = ? AND project IS NULL` : `key = ? AND project = ?`;
    const whereParams: (string | null)[] = project === null ? [key] : [key, project];

    const existing = this.db
      .prepare(`SELECT value, source FROM semantic WHERE ${where}`)
      .get(...whereParams) as { value: string; source: string } | null;

    if (existing) {
      // 覆盖写等于永久丢掉旧值，所以先把旧值留档（只追加，不参与检索和注入）
      if (existing.value !== value) {
        this.recordHistory(key, existing.value, existing.source, project);
      }
      this.db
        .prepare(
          `
        UPDATE semantic SET value = ?, confidence = ?, source = ?, updated_at = datetime('now'),
          superseded_by = NULL
        WHERE ${where}
      `,
        )
        .run(value, confidence, source, ...whereParams);
    } else {
      this.db
        .prepare(
          `
        INSERT INTO semantic (key, value, confidence, source, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
        )
        .run(key, value, confidence, source, project);
    }

    const scope = project ? `[project: ${project}]` : "[global]";
    this.logEvent("upsert", "semantic", key, `${scope} ${value}`);
  }

  /**
   * 把被覆盖掉的旧值留档（只追加，不参与检索与注入）。
   * 留档失败不影响主流程 —— 记忆写入本身比审计更重要。
   */
  private recordHistory(
    key: string,
    value: string,
    source: string,
    project: string | null,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO semantic_history (key, value, source, project) VALUES (?, ?, ?, ?)`,
        )
        .run(key, value, source, project);
    } catch {
      // 忽略留档失败
    }
  }

  /**
   * 读取某条事实被覆盖前的历史值（最新的在前）。
   *
   * @param key 键名
   * @param limit 最多返回多少条 (默认 10)
   */
  getSemanticHistory(
    key: string,
    limit: number = 10,
  ): Array<{ value: string; source: string; project: string | null; replaced_at: string }> {
    const stmt = this.db.prepare(`
      SELECT value, source, project, replaced_at
      FROM semantic_history
      WHERE key = ?
      ORDER BY replaced_at DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(key, limit) as Array<{
      value: string;
      source: string;
      project: string | null;
      replaced_at: string;
    }>;
  }

  /**
   * 按键名及可选的项目标识删除一条事实记忆记录。
   * 如果不传 project 参数 (undefined)，则删除对应 key 的所有记录（包括全局和所有项目特有的记录）。
   * 如果 project 传 null，则只删除全局记录。
   * 如果 project 是字符串，则仅删除对应项目的记录。
   *
   * 这是「用户明确要求忘掉」的路径，所以连留档一起清：semantic_history 里的旧值和
   * events 里的值都会被抹掉，否则工具说「已删除」而库里仍留着明文。
   *
   * @param key 要删除的键名
   * @param project 目标项目标识 (可选)
   * @returns {boolean} 如果有成功删除的记录则返回 true
   */
  deleteSemantic(key: string, project?: string | null): boolean {
    let result;
    if (project === undefined) {
      // 删除包含此键名的所有记录 (无论是否全局)
      result = this.db.prepare(`DELETE FROM semantic WHERE key = ?`).run(key);
    } else if (project === null) {
      result = this.db
        .prepare(`DELETE FROM semantic WHERE key = ? AND project IS NULL`)
        .run(key);
    } else {
      result = this.db
        .prepare(`DELETE FROM semantic WHERE key = ? AND project = ?`)
        .run(key, project);
    }
    if (result.changes > 0) {
      this.purgeSemanticTraces(key, project);
      this.logEvent("delete", "semantic", key, project ?? "global");
      return true;
    }
    return false;
  }

  /**
   * 清掉一条事实的可回溯痕迹（只给 deleteSemantic 用）：
   * - semantic_history 里留档的旧值（按作用域匹配）
   * - events.details 里的值（事件行保留，内容改成 [redacted]）
   */
  private purgeSemanticTraces(key: string, project?: string | null): void {
    if (project === undefined) {
      this.db.prepare(`DELETE FROM semantic_history WHERE key = ?`).run(key);
    } else if (project === null) {
      this.db
        .prepare(`DELETE FROM semantic_history WHERE key = ? AND project IS NULL`)
        .run(key);
    } else {
      this.db
        .prepare(`DELETE FROM semantic_history WHERE key = ? AND project = ?`)
        .run(key, project);
    }

    const scopeTag =
      project === undefined ? null : project === null ? "[global] " : `[project: ${project}] `;
    const rows = this.db
      .prepare(`SELECT id, details FROM events WHERE memory_type = 'semantic' AND memory_key = ?`)
      .all(key) as Array<{ id: number; details: string }>;
    const redact = this.db.prepare(`UPDATE events SET details = '[redacted]' WHERE id = ?`);
    for (const row of rows) {
      if (scopeTag === null || row.details.startsWith(scopeTag)) redact.run(row.id);
    }
  }

  /**
   * 根据项目作用域提取所有事实记忆记录。
   * 该方法会返回 全局记录 (project IS NULL) 加上对应 projectId 的项目私有记录。
   * 如果存在相同 key 的情况，项目私有的记录会覆盖掉全局记录 (去重)。
   * 默认只返回有效记录（未被整合取代的）。
   *
   * @param projectId 项目唯一标识 (可选)
   * @param includeSuperseded 是否包含已被整合取代的记录 (默认 false)
   * @returns 合并去重后的所有事实记忆记录数组
   */
  getAllSemantic(
    projectId?: string | null,
    includeSuperseded: boolean = false,
  ): SemanticEntry[] {
    const where = includeSuperseded
      ? projectId
        ? `(project IS NULL OR project = ?)`
        : `1`
      : projectId
        ? `superseded_by IS NULL AND (project IS NULL OR project = ?)`
        : `superseded_by IS NULL`;

    const stmt = this.db.prepare(`
      SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project, superseded_by
      FROM semantic
      WHERE ${where}
      ORDER BY updated_at DESC
    `);
    const rows = (projectId ? stmt.all(projectId) : stmt.all()) as SemanticEntry[];

    // 去重逻辑：对于同一个 key，带有 project 的局部记录优先级高于全局记录
    if (projectId) {
      const seen = new Map<string, SemanticEntry>();
      // 第一遍循环：优先收集属于当前项目的局部记录 (优先级更高)
      for (const row of rows) {
        if (row.project !== null) {
          seen.set(row.key, row);
        }
      }
      // 第二遍循环：把那些不存在局部覆盖的全局记录填充进去
      for (const row of rows) {
        if (row.project === null && !seen.has(row.key)) {
          seen.set(row.key, row);
        }
      }
      return Array.from(seen.values());
    }

    return rows;
  }

  /**
   * 按键名精确取回记录，包含全局与各项目作用域的版本。
   * 用于 `memory_get`：注入层只给出 `<key_index>` 键名时，靠它拿回全文。
   *
   * @param key 记忆的键名
   * @returns 该键名下的所有记录（项目级排在前，便于看到覆盖最具体的那条）
   */
  getSemanticByKey(key: string): SemanticEntry[] {
    const stmt = this.db.prepare(`
      SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project, superseded_by
      FROM semantic
      WHERE key = ?
      ORDER BY superseded_by IS NULL DESC, project IS NULL, project
    `);
    const rows = stmt.all(key) as SemanticEntry[];

    if (rows.length > 0) {
      this.db
        .prepare(`UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?`)
        .run(key);
    }
    return rows;
  }

  /**
   * 按项目作用域分页列出事实记忆，按 key 排序（顺序稳定，便于 offset 翻页）。
   * 用于 `memory_list`：不依赖关键词命中，可以确定性地把某个分类翻完。
   *
   * @param prefix 键名前缀（"pref" / "pref." / "tool.bulk_" 都可）；空串表示全部
   * @param offset 跳过多少条
   * @param limit 最多返回多少条
   * @param projectId 当前项目标识（返回 全局 + 该项目 的合并去重视图）
   * @param includeSuperseded 是否包含已被整合取代的记录 (默认 false)
   * @returns 本页记录与符合前缀的总条数
   */
  listSemanticPage(
    prefix: string,
    offset: number,
    limit: number,
    projectId?: string | null,
    includeSuperseded: boolean = false,
  ): { entries: SemanticEntry[]; total: number } {
    const p = prefix.trim();
    /** "pref" 匹配 pref.*，"tool.bulk_" 按字面前缀匹配，"pref.x" 命中自身 */
    const matches = (key: string): boolean => {
      if (!p) return true;
      if (!key.startsWith(p)) return false;
      return (
        p.endsWith(".") ||
        p.endsWith("_") ||
        key.length === p.length ||
        key[p.length] === "."
      );
    };
    const all = this.getAllSemantic(projectId ?? null, includeSuperseded)
      .filter((e) => matches(e.key))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      entries: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  // ─── 经验教训 (Lessons) 操作 ─────────────────────────────────────────────────────

  /**
   * 增加一条经验教训。
   * 此方法内置了相似度去重逻辑，可以拦截高度相似的重复记录。
   *
   * 去重只在「同类别 + 同方向 (AVOID/DO) + 同作用域」内进行：跨项目/跨方向比较会把
   * 另一处成立的规则误判成重复，让新规则根本落不了库。只差实例编号的平行规则
   * （module_1 / module_2）也不算重复。
   *
   * @param rule 教训规则的具体内容
   * @param category 类别 (如 'git', 'coding')
   * @param negative 是否为需要避免的反面教材 (默认 false)
   * @param source 来源标识 (默认 'user')
   * @param project 关联的项目标识 (默认 null 为全局)
   * @returns 成功则返回新生成的记录 ID，如果因为重复被拦截则返回 null
   */
  addLesson(
    rule: string,
    category: string = "general",
    negative: boolean = false,
    source: string = "user",
    project: string | null = null,
  ): string | null {
    const scope = project ?? null;
    const existing = this.getLessons().filter(
      (l) => l.category === category && l.negative === negative && (l.project ?? null) === scope,
    );
    for (const lesson of existing) {
      if (lesson.rule === rule) return null; // 完全一致的重复
      // 只差编号/路径的平行规则不是重复（否则 module_2 的规则会被 module_1 拒收）
      if (normalizeIdentifiers(lesson.rule) === normalizeIdentifiers(rule)) continue;
      if (jaccardSimilarity(lesson.rule, rule) >= 0.7) return null; // 语义足够相似
    }

    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO lessons (id, rule, category, source, negative, project)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, rule, category, source, negative ? 1 : 0, project);

    this.logEvent("add", "lesson", id, rule);
    return id;
  }

  /**
   * 通过 ID 删除一条经验教训（硬删除 + 抹掉审计日志里的规则文本）。
   *
   * 早期版本用 `is_deleted = 1` 软删除，规则文本一直留在库里；用户明确说「忘了这个」
   * 时那等于没删干净。历史软删除的行保持原样，新删除走硬删除。
   *
   * @param id 教训的主键 ID
   * @returns 是否成功删除
   */
  deleteLesson(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
    if (result.changes > 0) {
      this.db
        .prepare(
          `UPDATE events SET details = '[redacted]' WHERE memory_type = 'lesson' AND memory_key = ?`,
        )
        .run(id);
      this.logEvent("delete", "lesson", id, "");
      return true;
    }
    return false;
  }

  /**
   * 获取所有存活（未被删除）的经验教训记录。
   *
   * @param includeSuperseded 是否包含已被整合取代的教训 (默认 false)
   * @returns {LessonEntry[]} 所有的经验教训数组
   */
  getLessons(includeSuperseded: boolean = false): LessonEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, rule, category, source, negative, created_at, project, superseded_by
      FROM lessons
      WHERE is_deleted = 0${includeSuperseded ? "" : " AND superseded_by IS NULL"}
      ORDER BY created_at DESC
    `);
    const rows = stmt.all() as Array<
      Omit<LessonEntry, "negative"> & { negative: number }
    >;
    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  /**
   * 按当前项目作用域分页列出有效教训（新→旧，按 id 保证顺序稳定）。
   * 用于 `memory_list({ type: "lesson" })`：教训超过 statistics 倾倒上限后，
   * 没有它就只能靠关键词搜索，拿不到 id 也就删不掉单条。
   *
   * @param offset 跳过多少条
   * @param limit 最多返回多少条
   * @param projectId 当前项目标识（全局 + 该项目）
   * @param includeSuperseded 是否包含已被整合取代的教训 (默认 false)
   */
  listLessonPage(
    offset: number,
    limit: number,
    projectId?: string | null,
    includeSuperseded: boolean = false,
  ): { entries: LessonEntry[]; total: number } {
    const all = this.getLessons(includeSuperseded)
      .filter((l) => !l.project || !projectId || l.project === projectId)
      .sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
      );
    return {
      entries: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  /**
   * 搜索经验教训，优先使用 FTS5 引擎；查询含 CJK 或 FTS5 不可用时走 LIKE 子串匹配。
   *
   * @param query 搜索关键词
   * @param limit 最大返回条数 (默认 15)
   * @returns 匹配的教训记录数组
   */
  searchLessons(query: string, limit: number = 15): LessonEntry[] {
    if (!query.trim()) return [];

    let rows: Array<Omit<LessonEntry, "negative"> & { negative: number }>;

    // 含中文等 CJK 的查询绕开 FTS（unicode61 无法切分，MATCH 必然 0 命中）
    if (this.hasFTS5 && !HAS_CJK.test(query)) {
      try {
        const sanitized = query
          .replace(/['"]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `"${w}"`)
          .join(" OR ");

        if (!sanitized) return this.searchLessonsFallback(query, limit);

        const stmt = this.db.prepare(`
          SELECT l.id, l.rule, l.category, l.source, l.negative, l.created_at, l.project, l.superseded_by
          FROM lessons l
          JOIN lessons_fts f ON l.rowid = f.rowid
          WHERE lessons_fts MATCH ? AND l.is_deleted = 0 AND l.superseded_by IS NULL
          ORDER BY rank
          LIMIT ?
        `);
        rows = stmt.all(sanitized, limit) as typeof rows;
      } catch {
        return this.searchLessonsFallback(query, limit);
      }
    } else {
      return this.searchLessonsFallback(query, limit);
    }

    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  private searchLessonsFallback(query: string, limit: number): LessonEntry[] {
    const words = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${w}%`);
    if (words.length === 0) return [];

    const conditions = words
      .map(() => `(rule LIKE ? OR category LIKE ?)`)
      .join(" OR ");
    const params: (string | number)[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT id, rule, category, source, negative, created_at, project, superseded_by
      FROM lessons
      WHERE is_deleted = 0 AND superseded_by IS NULL AND (${conditions})
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params) as Array<
      Omit<LessonEntry, "negative"> & { negative: number }
    >;
    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  // ─── 操作事件审计 (Events) ──────────────────────────────────────────────────────

  /**
   * 记录一次记忆操作事件到审计日志表中。
   *
   * @param eventType 事件类型 (如 'add', 'delete')
   * @param memoryType 记忆表类型 (如 'semantic', 'lesson')
   * @param memoryKey 受影响的键名或 ID
   * @param details 详情
   */
  logEvent(
    eventType: string,
    memoryType: string,
    memoryKey: string,
    details: string,
  ): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (event_type, memory_type, memory_key, details)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(eventType, memoryType, memoryKey, details);
    } catch {
      // 记录日志并非核心阻断逻辑 — 忽略报错以防止影响主干运行
    }
  }

  // ─── 统计分析 (Stats) ───────────────────────────────────────────────────────

  /**
   * 获取数据库中各个表的数量统计信息。
   *
   * @returns {MemoryStats} 统计结果
   */
  getStats(): MemoryStats {
    const semantic = this.db
      .prepare(`SELECT COUNT(*) as count FROM semantic`)
      .get() as { count: number };
    const lessons = this.db
      .prepare(`SELECT COUNT(*) as count FROM lessons WHERE is_deleted = 0`)
      .get() as { count: number };
    const events = this.db
      .prepare(`SELECT COUNT(*) as count FROM events`)
      .get() as { count: number };
    const supersededFacts = this.db
      .prepare(`SELECT COUNT(*) as count FROM semantic WHERE superseded_by IS NOT NULL`)
      .get() as { count: number };
    const supersededLessons = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM lessons WHERE is_deleted = 0 AND superseded_by IS NOT NULL`,
      )
      .get() as { count: number };

    return {
      semanticCount: semantic.count,
      lessonCount: lessons.count,
      eventCount: events.count,
      semanticSuperseded: supersededFacts.count,
      lessonSuperseded: supersededLessons.count,
    };
  }

  /**
   * 获取最近的记忆操作日志。
   *
   * @param limit 返回的最大日志条数 (默认 5)
   * @returns {MemoryEvent[]} 事件日志数组
   */
  getRecentEvents(limit: number = 5): MemoryEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, event_type, memory_type, memory_key, details, created_at
      FROM events
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as MemoryEvent[];
  }

  // ─── 整合 (Consolidation) ───────────────────────────────────────────────────────

  /**
   * 规划一次整合，不改动数据库（dry run 用）。
   *
   * 只在「同前缀 + 同作用域」内比较，且事实与教训用不同口径：
   * - 事实只合并「完全相同」或「一条包含另一条」的条目。只差一个编号/路径的平行条目
   *   相似度往往 > 0.9，用相似度合并就是误合并，因此事实不参与相似度猜测。
   * - 教训是散文，按 threshold 做相似度合并（同类别 + 同方向 + 同作用域内）。
   * 已被取代的记录不参与下一轮规划，天然幂等。
   *
   * @param options.threshold 教训的相似度阈值 (0-1)，默认 DEFAULT_CONSOLIDATION_THRESHOLD
   * @param options.includeLessons 是否同时规划教训 (默认 true)
   * @returns 待执行的合并分组；空数组表示没有可整合的条目
   */
  planConsolidation(
    options: { threshold?: number; includeLessons?: boolean } = {},
  ): ConsolidationGroup[] {
    const threshold = Math.min(
      1,
      Math.max(0.3, options.threshold ?? DEFAULT_CONSOLIDATION_THRESHOLD),
    );
    const groups = this.planFactGroups(threshold);
    if (options.includeLessons !== false) {
      groups.push(...this.planLessonGroups(threshold));
    }
    return groups;
  }

  private planFactGroups(threshold: number): ConsolidationGroup[] {
    // 注意：桶内是两两比较（O(n²)）。前缀一般只有几十上百条，启动时跑一次可以接受；
    // 若某个前缀上千条，整合会明显变慢，此时更适合用 memory_list 人工整理。
    const buckets = new Map<string, SemanticEntry[]>();
    for (const row of this.getAllSemantic(null)) {
      const dot = row.key.indexOf(".");
      const prefix = dot > 0 ? row.key.slice(0, dot) : row.key;
      const bucketKey = `${prefix}\u0000${row.project ?? ""}`;
      const arr = buckets.get(bucketKey);
      if (arr) arr.push(row);
      else buckets.set(bucketKey, [row]);
    }

    const groups: ConsolidationGroup[] = [];
    for (const items of buckets.values()) {
      if (items.length < 2) continue;
      items.sort((a, b) => a.key.localeCompare(b.key));

      const clusters: SemanticEntry[][] = [];
      for (const item of items) {
        const cluster = clusters.find((c) =>
          isSameMemory(c[0]!.value, item.value, threshold, false),
        );
        if (cluster) cluster.push(item);
        else clusters.push([item]);
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        const keep = pickFactCanonical(cluster);
        const drops = cluster.filter((e) => e.key !== keep.key);
        groups.push({
          kind: "fact",
          keep: keep.key,
          keep_text: keep.value,
          drop: drops.map((e) => e.key),
          merged: mergeTexts(
            keep.value,
            drops.map((e) => e.value),
          ),
          similarity: maxPairSimilarity(cluster.map((e) => e.value)),
          scope: keep.project,
        });
      }
    }
    return groups;
  }

  private planLessonGroups(threshold: number): ConsolidationGroup[] {
    const buckets = new Map<string, LessonEntry[]>();
    for (const lesson of this.getLessons()) {
      // 方向（AVOID/DO）也参与分桶：不能把「该做」并成「别做」
      const bucketKey = `${lesson.category}\u0000${lesson.negative ? "1" : "0"}\u0000${lesson.project ?? ""}`;
      const arr = buckets.get(bucketKey);
      if (arr) arr.push(lesson);
      else buckets.set(bucketKey, [lesson]);
    }

    const groups: ConsolidationGroup[] = [];
    for (const items of buckets.values()) {
      if (items.length < 2) continue;
      items.sort((a, b) => a.id.localeCompare(b.id));

      const clusters: LessonEntry[][] = [];
      for (const item of items) {
        const cluster = clusters.find((c) =>
          isSameMemory(c[0]!.rule, item.rule, threshold, true),
        );
        if (cluster) cluster.push(item);
        else clusters.push([item]);
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        const keep = pickLessonCanonical(cluster);
        const drops = cluster.filter((e) => e.id !== keep.id);
        groups.push({
          kind: "lesson",
          keep: keep.id,
          keep_text: keep.rule,
          drop: drops.map((e) => e.id),
          merged: mergeTexts(
            keep.rule,
            drops.map((e) => e.rule),
          ),
          similarity: maxPairSimilarity(cluster.map((e) => e.rule)),
          scope: keep.project,
        });
      }
    }
    return groups;
  }

  /**
   * 执行整合：把 drop 标记为「被 keep 取代」，并写入合并后的内容。
   * 只标记不删除 —— 被取代的记录仍可被 memory_get / memory_list 查到。
   *
   * @returns 实际处理的条数
   */
  applyConsolidation(groups: ConsolidationGroup[]): {
    facts: number;
    lessons: number;
  } {
    let facts = 0;
    let lessons = 0;

    const run = this.db.transaction(() => {
      const markFact = this.db.prepare(
        `UPDATE semantic SET superseded_by = ?, updated_at = datetime('now')
         WHERE key = ? AND project IS ? AND superseded_by IS NULL`,
      );
      const rewriteFact = this.db.prepare(
        `UPDATE semantic SET value = ?, updated_at = datetime('now')
         WHERE key = ? AND project IS ?`,
      );
      const markLesson = this.db.prepare(
        `UPDATE lessons SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`,
      );
      const rewriteLesson = this.db.prepare(`UPDATE lessons SET rule = ? WHERE id = ?`);

      for (const group of groups) {
        if (group.drop.length === 0) continue;

        if (group.kind === "fact") {
          for (const dropKey of group.drop) {
            markFact.run(group.keep, dropKey, group.scope);
          }
          if (group.merged && group.merged !== group.keep_text) {
            this.recordHistory(group.keep, group.keep_text, "consolidation", group.scope);
            rewriteFact.run(group.merged, group.keep, group.scope);
          }
          this.logEvent(
            "consolidate",
            "semantic",
            group.keep,
            `merged ${group.drop.join(", ")}`,
          );
          facts++;
        } else {
          for (const dropId of group.drop) {
            markLesson.run(group.keep, dropId);
          }
          if (group.merged && group.merged !== group.keep_text) {
            rewriteLesson.run(group.merged, group.keep);
          }
          this.logEvent(
            "consolidate",
            "lesson",
            group.keep,
            `merged ${group.drop.join(", ")}`,
          );
          lessons++;
        }
      }
    });

    run();
    return { facts, lessons };
  }

  // ─── 生命周期管理 (Lifecycle) ───────────────────────────────────────────────────

  /**
   * 彻底关闭数据库连接。
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // 忽略关闭时的异常
    }
  }
}

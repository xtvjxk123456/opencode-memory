/**
 * 记忆注入器 (Memory Injector) — 负责从存储的记忆中构建出 XML 格式的上下文块。
 *
 * 移植自 pi-memory (https://github.com/samfoy/pi-memory)。
 *
 * 该模块会根据键名前缀将记忆分类成不同的区块：
 * - 偏好设置 (pref.*)
 * - 工具偏好 (tool.*)
 * - 用户身份 (user.*)
 * - 环境、通用等 (动态分组)
 * - 经验教训 (lessons) — 纠错记录和经过验证的方法
 *
 * 项目作用域 (Project scoping): 事实记忆支持使用 `project` 字段（Git 远程仓库 URL 或本地路径）进行隔离。
 * 注入时会同时包含 全局记忆 (project=NULL) + 当前项目记忆。
 * 如果出现相同的键名，当前项目级的记忆会覆盖全局级的记忆。
 *
 * 注入策略（2.1.0 起）— 注入层是「索引」，不是全文：
 * - 单条内容过长时压成一行并以 `…` 结尾，全文留在库里用 memory_search 取。
 * - 两级注入（2.2.0 起）：值装不下的条目不再被丢弃，而是退化成 `<key_index>` 里的
 *   纯键名。键名比「键名 + 值」小一个数量级，所以记忆库增长时覆盖率只缓慢下降。
 * - 键名也装不下时才截断，并附 `… (+N more keys)` 尾注，绝不静默消失。
 * - 教训有保底预算（lessonReserve），事实再多也挤不掉它。
 * - 分区内按 key 排序，内容不变时注入文本逐字节稳定，便于命中 prompt cache。
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";
import { basename } from "node:path";

/** `<memory>\n` + `\n</memory>` 占用的额外字符，用于把预算留给正文 */
const WRAPPER_CHARS = 19;

/**
 * 注入行为配置（可通过 ~/.config/opencode/supereasy-memory/config.json 覆盖）
 */
export interface InjectionConfig {
  /** 整个 <memory> 块的字符上限 */
  maxChars: number;
  /** 单条事实 value 注入时的最大字符数，超出截断并加 `…` */
  factLineMax: number;
  /** 单条教训压成一行后的最大字符数 */
  lessonLineMax: number;
  /** 教训的保底预算占比 (0-1)，避免被事实分区挤没 */
  lessonReserve: number;
}

/** 默认配置：保持 2.0.x 的 8000 字符上限，靠压缩而非加大预算来装下更多内容 */
export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  maxChars: 8000,
  factLineMax: 150,
  lessonLineMax: 100,
  lessonReserve: 0.3,
};

/**
 * 校验并补全外部传入的配置（配置文件可能缺字段或写错类型）。
 * 非法值一律回落默认值，保证注入永远能跑。
 */
export function normalizeInjectionConfig(input: unknown): InjectionConfig {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const n =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    maxChars: Math.floor(num(raw.maxChars, DEFAULT_INJECTION_CONFIG.maxChars, 1000, 200000)),
    factLineMax: Math.floor(num(raw.factLineMax, DEFAULT_INJECTION_CONFIG.factLineMax, 20, 100000)),
    lessonLineMax: Math.floor(
      num(raw.lessonLineMax, DEFAULT_INJECTION_CONFIG.lessonLineMax, 20, 100000),
    ),
    lessonReserve: num(raw.lessonReserve, DEFAULT_INJECTION_CONFIG.lessonReserve, 0, 1),
  };
}

/**
 * 注入器返回的上下文块数据结构
 */
export interface ContextBlock {
  /** 格式化好的 XML 文本 */
  text: string;
  /** 统计数据（也是 memory_stats 里「注入报告」的数据源） */
  stats: {
    /** 注入文本的总字符数 */
    chars: number;
    /** 当前的字符上限 */
    maxChars: number;
    /** 内联了 value 的事实条数 */
    semantic: number;
    /** 参与注入的事实总数 */
    semanticTotal: number;
    /** 只出现在 <key_index> 里、只有键名没有 value 的事实条数 */
    keys: number;
    /** 实际注入的教训条数 */
    lessons: number;
    /** 参与注入的教训总数 */
    lessonsTotal: number;
    /** 被截断的分区及丢弃条数（空数组表示全部装下） */
    truncated: Array<{ section: string; dropped: number }>;
  };
}

/**
 * 从当前工作目录解析出当前项目的唯一标识符。
 * 优先级 1: Git 远程仓库的 URL (会自动剥离 http 协议前缀和 .git 后缀)
 * 优先级 2: 标准化后的绝对路径 (转为小写并使用正斜杠)
 *
 * 使用 Git 远程 URL 作为标识的好处在于：同一个仓库无论被 clone 到哪台电脑或哪个目录下，
 * 都会自动共享该项目作用域下的所有记忆。
 *
 * @param cwd 当前工作目录的绝对路径
 * @returns 项目的唯一标识字符串
 */
export function resolveProjectId(cwd: string): string {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = proc.stdout.toString().trim();
    if (url) {
      // 转换格式示例：
      // "https://github.com/user/repo.git" → "github.com/user/repo"
      // "git@github.com:user/repo.git" → "github.com/user/repo"
      return url
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/:/g, "/")
        .replace(/\.git$/, "")
        .toLowerCase();
    }
  } catch {
    // git 命令不可用或者当前目录不是一个 git 仓库
  }
  // 降级方案: 使用标准化的绝对路径
  return cwd.replace(/\\/g, "/").toLowerCase();
}

/**
 * 从目录路径中提取出适合展示的项目名称。
 * 通常只提取最后一段目录名，用于给用户展示友好的提示信息。
 *
 * @param cwd 当前工作目录的绝对路径
 * @returns 友好的项目名称
 */
export function projectDisplayName(cwd: string): string {
  return basename(cwd);
}

/** 将键名人性化以便于大模型阅读：剥离已知的前缀，并将下划线和点替换为空格。 */
function humanizeKey(key: string): string {
  const dotIdx = key.indexOf(".");
  const stripped = dotIdx > 0 ? key.slice(dotIdx + 1) : key;
  return stripped.replace(/[._]/g, " ").trim();
}

/** 压成一行并截断到 max 个字符；截断时以 `…` 结尾（配合上下文里的说明即可检索全文）。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/**
 * 教训压成一行：取首句，必要时截断到 max。
 * 有后文（或发生截断）时以 `…` 结尾，提示模型库里还有全文可检索。
 */
function lessonText(rule: string, max: number): string {
  const flat = rule.replace(/\s+/g, " ").trim();
  const head = (flat.match(/^.*?[。；;！!？?]/) || [flat])[0].trim();
  const hasMore = head.length < flat.length;
  if (head.length > max) {
    return head.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
  }
  return hasMore ? head.replace(/[。；;！!？?]+$/, "") + "…" : head;
}

/** 针对一些众所周知的前缀提供语义化更友好的分组标签名 */
const GROUP_NAMES: Record<string, string> = {
  pref: "preferences",
  project: "project_context",
  tool: "tool_preferences",
  user: "user_identity",
};

/** 按键名第一个小数点解析出分组标签；没有前缀的归入 general。 */
function groupTagOf(key: string): string {
  const dotIdx = key.indexOf(".");
  const rawPrefix = dotIdx > 0 ? key.slice(0, dotIdx) : "general";
  return GROUP_NAMES[rawPrefix] || rawPrefix;
}

/** 渲染一个 XML 分区 */
function renderSection(tag: string, lines: string[]): string {
  return `  <${tag}>\n${lines.join("\n")}\n  </${tag}>`;
}

/** <key_index> 的折行宽度：一行太长不好读，也不影响体积 */
const KEY_LINE_WIDTH = 120;

/** 把一个分组的纯键名折成若干行，尽量少占用字符（逗号 + 空格，不加前缀符号）。 */
function wrapKeys(tag: string, keys: string[]): string[] {
  const indent = "    ";
  const lines: string[] = [];
  let current = `${indent}${tag}: `;
  let first = true;
  for (const key of keys) {
    const piece = first ? key : `, ${key}`;
    if (current.length + piece.length > KEY_LINE_WIDTH && !first) {
      lines.push(current);
      current = `${indent}  ${key}`;
    } else {
      current += piece;
    }
    first = false;
  }
  lines.push(current);
  return lines;
}

/**
 * 构建完整的记忆上下文块，用于在系统提示词前进行被动注入。
 *
 * 当传入了 `projectId` 时，存储层会返回 全局记忆 + 该项目的局部记忆
 * (遇到键名冲突时，项目级记忆会覆盖全局级记忆)。
 *
 * @param store MemoryStore 数据库存储实例
 * @param projectId 当前项目的唯一标识（可选）
 * @param config 注入配置（可选，默认 DEFAULT_INJECTION_CONFIG）
 * @returns 构建好的包含 XML 和统计信息的 ContextBlock 对象
 */
export function buildContextBlock(
  store: MemoryStore,
  projectId?: string,
  config: InjectionConfig = DEFAULT_INJECTION_CONFIG,
): ContextBlock {
  const cfg = normalizeInjectionConfig(config);
  /** 正文预算：总上限扣掉 <memory> 包装标签的固定开销 */
  const bodyBudget = Math.max(200, cfg.maxChars - WRAPPER_CHARS);

  const allEntries = store.getAllSemantic(projectId || null);
  const allLessons = store.getLessons();

  // 过滤出属于全局或当前项目的经验教训
  const lessons = allLessons.filter(
    (l) => !l.project || !projectId || l.project === projectId,
  );

  const empty = (): ContextBlock => ({
    text: "",
    stats: {
      chars: 0,
      maxChars: cfg.maxChars,
      semantic: 0,
      semanticTotal: allEntries.length,
      keys: 0,
      lessons: 0,
      lessonsTotal: lessons.length,
      truncated: [],
    },
  });

  if (allEntries.length === 0 && lessons.length === 0) return empty();

  // ── 通过键名的第一个小数点进行动态分组 ──────────────
  const groupMap = new Map<string, SemanticEntry[]>();

  for (const entry of allEntries) {
    const groupKey = groupTagOf(entry.key);
    const arr = groupMap.get(groupKey);
    if (arr) arr.push(entry);
    else groupMap.set(groupKey, [entry]);
  }

  // 分区内按 key 排序：内容不变时注入文本逐字节稳定，可稳定命中 prompt cache
  for (const arr of groupMap.values()) {
    arr.sort((a, b) => a.key.localeCompare(b.key));
  }

  const factLine = (e: SemanticEntry): string =>
    `    - ${humanizeKey(e.key)}: ${clip(e.value, cfg.factLineMax)}`;

  const lessonLines = lessons.map((l: LessonEntry) => {
    const prefix = l.negative ? "[AVOID]" : "[DO]";
    return `    ${prefix} ${lessonText(l.rule, cfg.lessonLineMax)}`;
  });

  // 优先级顺序：保证这些重要的内置分组优先拿到预算
  const priorityOrder = [
    "preferences",
    "project_context",
    "tool_preferences",
    "user_identity",
  ];
  const priority: Array<{ tag: string; entries: SemanticEntry[] }> = [];
  for (const key of priorityOrder) {
    const entries = groupMap.get(key);
    if (entries) {
      priority.push({ tag: key, entries });
      groupMap.delete(key);
    }
  }

  // 剩余的其他动态分组按首字母升序排序
  const rest: Array<{ tag: string; entries: SemanticEntry[] }> = Array.from(
    groupMap.keys(),
  )
    .sort()
    .map((key) => ({ tag: key, entries: groupMap.get(key)! }));

  // ── 预算分配：先保住教训的保底份额，再让事实用剩下的 ──────────────
  const sectionLen = (s: { tag: string; entries: SemanticEntry[] }): number =>
    renderSection(s.tag, s.entries.map(factLine)).length + 1; // +1 是 sections.join("\n") 的分隔符
  const factsFull = [...priority, ...rest].reduce((n, s) => n + sectionLen(s), 0);
  const lessonsFull = lessonLines.length
    ? renderSection("lessons", lessonLines).length + 1
    : 0;

  const fitsAll = factsFull + lessonsFull <= bodyBudget;
  const lessonBudget = fitsAll
    ? lessonsFull
    : Math.min(
        lessonsFull,
        Math.max(
          Math.ceil(bodyBudget * cfg.lessonReserve),
          bodyBudget - factsFull,
        ),
      );

  const truncated: Array<{ section: string; dropped: number }> = [];
  let lessonCount = 0;
  let lessonSection: string | null = null;
  let lessonsUsed = 0;

  if (lessonLines.length > 0) {
    // 教训是一行一条的短规则，长度稳定，保持原有的「整段放 + 尾部截断」策略
    const full = renderSection("lessons", lessonLines);
    let admitted: { text: string; count: number; dropped: number } | null = null;
    if (full.length <= lessonBudget) {
      admitted = { text: full, count: lessonLines.length, dropped: 0 };
    } else {
      for (let n = lessonLines.length - 1; n >= 0; n--) {
        const dropped = lessonLines.length - n;
        const text = renderSection("lessons", [
          ...lessonLines.slice(0, n),
          `    … (+${dropped} more — memory_search)`,
        ]);
        if (text.length <= lessonBudget) {
          admitted = { text, count: n, dropped };
          break;
        }
      }
    }

    if (admitted) {
      lessonSection = admitted.text;
      lessonCount = admitted.count;
      lessonsUsed = admitted.text.length + 1;
      if (admitted.dropped > 0) {
        truncated.push({ section: "lessons", dropped: admitted.dropped });
      }
    } else {
      truncated.push({ section: "lessons", dropped: lessonLines.length });
    }
  }

  // ── 事实的两级分配 ──────────────────────────────────────────────
  // 注入顺序：优先级分区在前，其余按字母序；分区内已按 key 排序。
  // 「带值」和「只留键名」共用同一份预算：带值一条 ~150+ 字符，只留键名一条 ~20 字符。
  // 所以在「前 k 条带值、其余留键名」上二分，取预算允许的最大 k ——
  // 结果是宁可少带几条的值，也要让每个条目至少留下键名。
  const PRIORITY_TAGS = new Set(priorityOrder);
  const ordered: Array<{ tag: string; entry: SemanticEntry }> = [];
  for (const s of priority) {
    for (const e of s.entries) ordered.push({ tag: s.tag, entry: e });
  }
  for (const s of rest) {
    for (const e of s.entries) ordered.push({ tag: s.tag, entry: e });
  }

  /** 前 k 条带值、其余只留键名时的完整渲染结果 */
  const layoutAt = (k: number) => {
    const buckets = new Map<
      string,
      { tag: string; values: SemanticEntry[]; keys: string[] }
    >();
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i]!;
      let bucket = buckets.get(item.tag);
      if (!bucket) {
        bucket = { tag: item.tag, values: [], keys: [] };
        buckets.set(item.tag, bucket);
      }
      if (i < k) bucket.values.push(item.entry);
      else bucket.keys.push(item.entry.key);
    }

    const priorityParts: string[] = [];
    const restParts: string[] = [];
    const groups: Array<{ tag: string; keys: string[] }> = [];
    let semantic = 0;
    let keys = 0;

    for (const bucket of buckets.values()) {
      if (bucket.values.length > 0) {
        const text = renderSection(bucket.tag, bucket.values.map(factLine));
        if (PRIORITY_TAGS.has(bucket.tag)) priorityParts.push(text);
        else restParts.push(text);
        semantic += bucket.values.length;
      }
      if (bucket.keys.length > 0) {
        groups.push({ tag: bucket.tag, keys: bucket.keys });
        keys += bucket.keys.length;
      }
    }

    const indexText =
      groups.length > 0
        ? renderSection(
            "key_index",
            groups.flatMap((g) => wrapKeys(g.tag, g.keys)),
          )
        : "";
    const length = [...priorityParts, ...restParts, indexText]
      .filter(Boolean)
      .join("\n").length;

    return { priorityParts, restParts, indexText, semantic, keys, length };
  };

  const factsBudget = Math.max(0, bodyBudget - lessonsUsed);
  let lo = 0;
  let hi = ordered.length;
  let bestK = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layoutAt(mid).length <= factsBudget) {
      bestK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let layout = layoutAt(bestK);
  if (layout.length > factsBudget) {
    // 连键名都装不下：至少留一行交代丢了多少条，而不是静默消失
    const trailer = renderSection("key_index", [
      `    … (+${ordered.length} more keys — memory_list)`,
    ]);
    const fits = trailer.length <= factsBudget;
    layout = {
      priorityParts: [],
      restParts: [],
      indexText: fits ? trailer : "",
      semantic: 0,
      keys: 0,
      length: fits ? trailer.length : 0,
    };
  }

  const semanticCount = layout.semantic;
  const keyCount = layout.keys;
  const droppedKeys = ordered.length - layout.semantic - layout.keys;
  if (droppedKeys > 0) {
    truncated.push({ section: "key_index", dropped: droppedKeys });
  }

  const sections = [
    ...layout.priorityParts,
    ...(lessonSection ? [lessonSection] : []),
    ...layout.restParts,
    ...(layout.indexText ? [layout.indexText] : []),
  ];

  if (sections.length === 0) return empty();

  const text = `<memory>\n${sections.join("\n")}\n</memory>`;
  return {
    text,
    stats: {
      chars: text.length,
      maxChars: cfg.maxChars,
      semantic: semanticCount,
      semanticTotal: allEntries.length,
      keys: keyCount,
      lessons: lessonCount,
      lessonsTotal: lessons.length,
      truncated,
    },
  };
}

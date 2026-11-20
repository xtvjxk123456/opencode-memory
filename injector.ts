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
 * - 总长度有上限，但任何分区都不会被静默整块丢弃：装不下只丢尾部，并附 `… (+N more)` 尾注。
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
    /** 实际注入的事实条数 */
    semantic: number;
    /** 参与注入的事实总数 */
    semanticTotal: number;
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
      lessons: 0,
      lessonsTotal: lessons.length,
      truncated: [],
    },
  });

  if (allEntries.length === 0 && lessons.length === 0) return empty();

  // ── 通过键名的第一个小数点进行动态分组 ──────────────
  const groupMap = new Map<string, SemanticEntry[]>();

  /** 针对一些众所周知的前缀提供语义化更友好的分组标签名 */
  const groupNames: Record<string, string> = {
    pref: "preferences",
    project: "project_context",
    tool: "tool_preferences",
    user: "user_identity",
  };

  for (const entry of allEntries) {
    const dotIdx = entry.key.indexOf(".");
    const rawPrefix = dotIdx > 0 ? entry.key.slice(0, dotIdx) : "general";
    const groupKey = groupNames[rawPrefix] || rawPrefix;
    const arr = groupMap.get(groupKey);
    if (arr) arr.push(entry);
    else groupMap.set(groupKey, [entry]);
  }

  // 分区内按 key 排序：内容不变时注入文本逐字节稳定，可稳定命中 prompt cache
  for (const arr of groupMap.values()) {
    arr.sort((a, b) => a.key.localeCompare(b.key));
  }

  const factLines = (entries: SemanticEntry[]): string[] =>
    entries.map((e) => `    - ${humanizeKey(e.key)}: ${clip(e.value, cfg.factLineMax)}`);

  const lessonLines = lessons.map((l: LessonEntry) => {
    const prefix = l.negative ? "[AVOID]" : "[DO]";
    return `    ${prefix} ${lessonText(l.rule, cfg.lessonLineMax)}`;
  });

  const render = (tag: string, lines: string[]): string =>
    `  <${tag}>\n${lines.join("\n")}\n  </${tag}>`;

  /**
   * 把一个分区放进预算里：装得下就整块放，装不下就只放前缀并附 `… (+N more)` 尾注。
   * 返回 null 表示连一条都放不下（调用方记为整区丢失）。
   */
  const admit = (
    tag: string,
    lines: string[],
    used: number,
    budget: number,
  ): { text: string; count: number; dropped: number } | null => {
    if (lines.length === 0) return null;
    const full = render(tag, lines);
    if (used + full.length <= budget) {
      return { text: full, count: lines.length, dropped: 0 };
    }
    for (let n = lines.length - 1; n >= 0; n--) {
      const dropped = lines.length - n;
      const text = render(tag, [
        ...lines.slice(0, n),
        `    … (+${dropped} more — memory_search)`,
      ]);
      if (used + text.length <= budget) return { text, count: n, dropped };
    }
    return null;
  };

  // 优先级顺序：保证这些重要的内置分组优先拿到预算
  const priorityOrder = [
    "preferences",
    "project_context",
    "tool_preferences",
    "user_identity",
  ];
  const priority: Array<{ tag: string; lines: string[] }> = [];
  for (const key of priorityOrder) {
    const entries = groupMap.get(key);
    if (entries) {
      priority.push({ tag: key, lines: factLines(entries) });
      groupMap.delete(key);
    }
  }

  // 剩余的其他动态分组按首字母升序排序
  const rest: Array<{ tag: string; lines: string[] }> = Array.from(groupMap.keys())
    .sort()
    .map((key) => ({ tag: key, lines: factLines(groupMap.get(key)!) }));

  // ── 预算分配：先保住教训的保底份额，再让事实用剩下的 ──────────────
  const sectionLen = (s: { tag: string; lines: string[] }): number =>
    render(s.tag, s.lines).length + 1; // +1 是 sections.join("\n") 的分隔符
  const factsFull = [...priority, ...rest].reduce((n, s) => n + sectionLen(s), 0);
  const lessonsFull = lessonLines.length ? render("lessons", lessonLines).length + 1 : 0;

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

  const sections: string[] = [];
  const truncated: Array<{ section: string; dropped: number }> = [];
  let used = 0;
  let semanticCount = 0;
  let lessonCount = 0;
  let lessonSection: string | null = null;

  if (lessonLines.length > 0) {
    const admitted = admit("lessons", lessonLines, 0, lessonBudget);
    if (admitted) {
      lessonSection = admitted.text;
      lessonCount = admitted.count;
      used += admitted.text.length + 1;
      if (admitted.dropped > 0) {
        truncated.push({ section: "lessons", dropped: admitted.dropped });
      }
    } else {
      truncated.push({ section: "lessons", dropped: lessonLines.length });
    }
  }

  const take = (s: { tag: string; lines: string[] }): void => {
    const admitted = admit(s.tag, s.lines, used, bodyBudget);
    if (!admitted) {
      truncated.push({ section: s.tag, dropped: s.lines.length });
      return;
    }
    sections.push(admitted.text);
    used += admitted.text.length + 1;
    semanticCount += admitted.count;
    if (admitted.dropped > 0) {
      truncated.push({ section: s.tag, dropped: admitted.dropped });
    }
  };

  for (const s of priority) take(s);
  if (lessonSection) sections.push(lessonSection);
  for (const s of rest) take(s);

  if (sections.length === 0) return empty();

  const text = `<memory>\n${sections.join("\n")}\n</memory>`;
  return {
    text,
    stats: {
      chars: text.length,
      maxChars: cfg.maxChars,
      semantic: semanticCount,
      semanticTotal: allEntries.length,
      lessons: lessonCount,
      lessonsTotal: lessons.length,
      truncated,
    },
  };
}

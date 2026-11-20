/**
 * supereasy-memory — OpenCode 持久化记忆插件（OpenCode V2 版）。
 *
 * 由 V1 插件 (https://github.com/songsongtao/opencode-memory) 移植到 OpenCode 2 插件 API：
 * - 入口改为 default 导出的 `{ id, setup }` 定义对象（V2 插件协议）。
 * - 4 个工具通过 `ctx.tool.transform` 注册，参数使用 JSON Schema（不再依赖 zod）。
 * - 记忆注入改为 `ctx.session.hook("context")`：在每次模型请求的 system 段注入。
 *   V2 的 hook 修改不会写入会话历史，因此按请求注入；注入内容固定（分区内按 key 排序），
 *   可命中 prompt cache，开销很小；压缩（compaction）后也不会丢失记忆，
 *   故 V1 的 `experimental.session.compacting` 钩子不再需要。
 * - 注入层是「索引」：长条目压成一行，全文留在库里用 memory_search 取；超出字符上限的分区
 *   只丢尾部并附尾注，不会整块消失（详见 injector.ts 与 config.json）。
 * - 子代理会话（`session.parentID` 非空）跳过注入，保持子代理上下文纯粹。
 * - 存储层 store.ts / 注入器 injector.ts 与 V1 完全一致，继续使用同一个
 *   SQLite 数据库（~/.config/opencode/supereasy-memory/supereasy-memory.db）。
 */
import type { Plugin } from "@opencode/plugin"; // 仅类型使用，运行时零第三方依赖
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { MemoryStore } from "./store.js";
import {
  buildContextBlock,
  resolveProjectId,
  projectDisplayName,
  normalizeInjectionConfig,
  DEFAULT_INJECTION_CONFIG,
  type InjectionConfig,
} from "./injector.js";

const MEMORY_MARKER = "<!-- supereasy-memory-context -->";

/** 插件数据目录：数据库和 config.json 都放在这里 */
const CONFIG_DIR = join(homedir(), ".config", "opencode", "supereasy-memory");

/**
 * 读取注入配置（可选）。文件不存在或内容非法时回落到默认值。
 * 只在插件 setup 时读一次，改完 config.json 需重启 OpenCode（或触发插件重载）才生效。
 */
function loadInjectionConfig(): InjectionConfig {
  const file = join(CONFIG_DIR, "config.json");
  try {
    if (!existsSync(file)) return DEFAULT_INJECTION_CONFIG;
    return normalizeInjectionConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.warn("[supereasy-memory] config.json 读取失败，使用默认注入配置:", err);
    return DEFAULT_INJECTION_CONFIG;
  }
}

// ─── 数据库单例 ─────────────────────────────────────────────────
// 挂在 globalThis 上，插件热重载（reload）时复用同一个连接，避免连接泄漏。
// 但缓存必须能识别「模块已换版本」：否则 store.ts 改了、热重载生效了，
// 拿到的仍是旧模块里的类实例，方法还是老逻辑（实测表现为“改了没反应”）。

const STORE_KEY = Symbol.for("supereasy-memory.store");

/** 每次模块加载都会产生一个新对象，热重载后与旧模块的 token 必然不同 */
const MODULE_TOKEN = {};

/** globalThis 上缓存的槽位：模块 token + 实例 */
interface StoreSlot {
  token: unknown;
  store: MemoryStore;
}

/**
 * 获取或初始化全局的 MemoryStore 数据库实例。
 * 数据库文件存放在 OpenCode 配置目录下:
 * ~/.config/opencode/supereasy-memory/supereasy-memory.db
 */
function getStore(): MemoryStore {
  const g = globalThis as unknown as Record<PropertyKey, unknown>;
  const slot = g[STORE_KEY] as StoreSlot | undefined;
  if (slot && slot.token === MODULE_TOKEN) return slot.store;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // 旧实例不主动 close：同一进程可能有多个会话共用它，交给 GC 回收
  const store = new MemoryStore(join(CONFIG_DIR, "supereasy-memory.db"));
  g[STORE_KEY] = { token: MODULE_TOKEN, store } satisfies StoreSlot;
  return store;
}

/**
 * 剥离字符串值外层多余的一层引号。
 * 部分大模型在输出工具参数时会出现双重 JSON 编码（字符串首尾带引号）。
 */
function stripQuotes(v: string): string {
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      try {
        if (first === '"') return JSON.parse(s) as string;
      } catch {
        /* fall through */
      }
      return s.slice(1, -1);
    }
  }
  return v;
}

// ─── 工具定义层 ────────────────────────────────────────────────

interface MemoryTool {
  name: string;
  description: string;
  input: any;
  options?: any;
  execute: (input: any, context: any) => Promise<{ content: string }>;
}

/**
 * 构建 4 个记忆工具。
 * 工具是一段闭包，项目标识在插件 setup 时解析并捕获。
 *
 * @param projectId 当前项目的唯一标识（git remote URL 或目录路径）
 * @param projectName 当前项目展示名
 * @param injectionConfig 注入配置（memory_stats 用它复算「注入报告」）
 */
function buildTools(
  projectId: string,
  projectName: string,
  injectionConfig: InjectionConfig,
): MemoryTool[] {
  // codemode: false 保持工具直接出现在模型的工具列表里（与 V1 行为一致），
  // 不放进 Code Mode 的脚本目录中。
  const direct: { codemode: false } = { codemode: false };

  const memorySearch: MemoryTool = {
    name: "memory_search",
    description:
      "Search stored memories (facts and lessons) by keyword. Use this proactively to find relevant past knowledge before making decisions or answering questions, or when the user explicitly asks to 'search memory' (搜索记忆), 'what did I say' (我之前说了什么) etc.",
    options: direct,
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase to find relevant memories",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(rawInput) {
      const args = (rawInput ?? {}) as { query?: string };
      const s = getStore();
      const query = stripQuotes(String(args.query ?? ""));

      const semanticResults = s.searchSemantic(query, 10);
      const lessonResults = s.searchLessons(query, 10);

      if (semanticResults.length === 0 && lessonResults.length === 0) {
        return { content: `No memories found matching "${query}".` };
      }

      const parts: string[] = [];

      if (semanticResults.length > 0) {
        parts.push("## Facts");
        for (const entry of semanticResults) {
          parts.push(
            `- **${entry.key}**: ${entry.value} (confidence: ${entry.confidence})`,
          );
        }
      }

      if (lessonResults.length > 0) {
        parts.push("## Lessons");
        for (const lesson of lessonResults) {
          const prefix = lesson.negative ? "[AVOID]" : "[DO]";
          parts.push(`- ${prefix} ${lesson.rule} (category: ${lesson.category})`);
        }
      }

      return { content: parts.join("\n") };
    },
  };

  const memoryRemember: MemoryTool = {
    name: "memory_remember",
    description:
      'Store a fact or lesson in persistent memory. Facts are key-value pairs (e.g. "pref.", "env.", "tool.", "user."). Lessons are corrections or validated approaches. PROACTIVELY use this when the user says "remember this" (记住这个), "add memory" (添加记忆), "add lesson" (添加教训) or when you notice an important preference or correction. NEVER ask for permission if the user explicitly commands you to remember something. After saving, ALWAYS tell the user the chosen scope (global or project) and hint they can change it.',
    options: direct,
    input: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["fact", "lesson"],
          description:
            'Type of memory to store: "fact" for key-value facts, "lesson" for corrections/approaches',
        },
        key: {
          type: "string",
          description:
            'Memory key for facts (e.g., "pref.commit_style", "tool.sed", "user.timezone"). Required when type is "fact".',
        },
        value: {
          type: "string",
          description:
            'Memory value for facts (e.g., "conventional commits"). Required when type is "fact".',
        },
        confidence: {
          type: "number",
          description: "Confidence score 0-1 for facts (default: 0.9)",
        },
        scope: {
          type: "string",
          enum: ["global", "project"],
          description:
            'Scope of the memory. "global" applies everywhere, "project" applies only to the current project. If not specified, infer from context: if the user mentions "this project" or project-specific details, use "project"; otherwise default to "global".',
        },
        rule: {
          type: "string",
          description:
            'Lesson rule description. Required when type is "lesson". Keep it to one short actionable sentence (≤120 chars); put long background or reference detail in a fact instead. Example: "Use sed for daily note insertion, not echo >>"',
        },
        category: {
          type: "string",
          description:
            'Lesson category (default: "general"). Examples: "git", "coding", "deployment"',
        },
        negative: {
          type: "boolean",
          description:
            "Whether this lesson is something to AVOID (true) or something recommended to DO (false, default)",
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
    async execute(rawInput) {
      const args = (rawInput ?? {}) as {
        type?: string;
        key?: string;
        value?: string;
        confidence?: number;
        scope?: string;
        rule?: string;
        category?: string;
        negative?: boolean;
      };
      const s = getStore();
      const type = stripQuotes(String(args.type ?? ""));

      if (type === "fact") {
        if (!args.key || !args.value) {
          return {
            content: 'Error: "key" and "value" are required when type is "fact".',
          };
        }
        const key = stripQuotes(args.key);
        const value = stripQuotes(args.value);
        const confidence = args.confidence ?? 0.9;
        const scopeStr = args.scope ? stripQuotes(args.scope) : "global";

        // 根据作用域结合当前项目标识，解析出最终存储的 project 字段
        const project = scopeStr === "project" ? projectId : null;
        s.upsertSemantic(key, value, confidence, "user", project);

        const scopeLabel = project ? `项目: ${projectName}` : "全局";
        return {
          content: `✓ 已保存 [${scopeLabel}]: ${key} = "${value}"\n如需改为${project ? "全局" : "仅当前项目"}生效，请告诉我。`,
        };
      }

      if (type === "lesson") {
        if (!args.rule) {
          return {
            content: 'Error: "rule" is required when type is "lesson".',
          };
        }
        const rule = stripQuotes(args.rule);
        const category = args.category ? stripQuotes(args.category) : "general";
        const negative = args.negative ?? false;
        const scopeStr = args.scope ? stripQuotes(args.scope) : "global";
        const project = scopeStr === "project" ? projectId : null;

        const id = s.addLesson(rule, category, negative, "user", project);
        if (id) {
          const prefix = negative ? "[AVOID]" : "[DO]";
          const scopeLabel = project ? `项目: ${projectName}` : "全局";
          return {
            content: `✓ 已保存教训 [${scopeLabel}] ${prefix}: "${rule}"\n如需改为${project ? "全局" : "仅当前项目"}生效，请告诉我。`,
          };
        }
        return {
          content: `⚠ 教训已存在或与已有教训过于相似: "${rule}"`,
        };
      }

      return {
        content: `Error: Unknown type "${type}". Use "fact" or "lesson".`,
      };
    },
  };

  const memoryForget: MemoryTool = {
    name: "memory_forget",
    description:
      "Delete a specific memory by its key (for facts) or ID (for lessons). Use this when the user says 'forget this' (忘了这个), 'delete memory' (删除记忆). For facts, deletes both global and project-scoped versions unless scope is specified.",
    options: direct,
    input: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["fact", "lesson"],
          description: 'Type of memory to delete: "fact" or "lesson"',
        },
        key: {
          type: "string",
          description: "The key of the fact or the ID of the lesson to delete",
        },
        scope: {
          type: "string",
          enum: ["global", "project", "all"],
          description:
            'For facts: "global" deletes global version, "project" deletes project version, "all" (default) deletes both.',
        },
      },
      required: ["type", "key"],
      additionalProperties: false,
    },
    async execute(rawInput) {
      const args = (rawInput ?? {}) as {
        type?: string;
        key?: string;
        scope?: string;
      };
      const s = getStore();
      const type = stripQuotes(String(args.type ?? ""));
      const key = stripQuotes(String(args.key ?? ""));

      if (type === "fact") {
        const scopeStr = args.scope ? stripQuotes(args.scope) : "all";
        let project: string | null | undefined;
        if (scopeStr === "global") project = null;
        else if (scopeStr === "project") project = projectId;
        else project = undefined; // "all" → 删除所有作用域下的该键

        const deleted = s.deleteSemantic(key, project);
        return {
          content: deleted
            ? `✓ 已删除事实: ${key} (${scopeStr === "all" ? "所有作用域" : scopeStr === "global" ? "全局" : `项目: ${projectName}`})`
            : `⚠ 未找到事实: ${key}`,
        };
      }

      if (type === "lesson") {
        const deleted = s.deleteLesson(key);
        return {
          content: deleted ? `✓ 已删除教训: ${key}` : `⚠ 未找到教训: ${key}`,
        };
      }

      return {
        content: `Error: Unknown type "${type}". Use "fact" or "lesson".`,
      };
    },
  };

  const memoryStats: MemoryTool = {
    name: "memory_stats",
    description:
      "Show memory statistics: total facts, lessons, events count, and scope breakdown. It also reports what the current session actually injects (chars used, entries included, truncated sections), the latest 5 log events and all stored memories.",
    options: direct,
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const s = getStore();
      const stats = s.getStats();
      const allEntries = s.getAllSemantic();
      const recentEvents = s.getRecentEvents(5);
      const allLessons = s.getLessons();

      // 按作用域统计数据
      let globalCount = 0;
      let projectCount = 0;
      const prefixCounts = new Map<string, number>();
      for (const entry of allEntries) {
        if (entry.project) projectCount++;
        else globalCount++;
        const prefix = entry.key.split(".")[0] || "other";
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
      }

      const parts = [
        "## Memory Statistics",
        `- **Facts**: ${stats.semanticCount} (global: ${globalCount}, project: ${projectCount})`,
        `- **Lessons**: ${stats.lessonCount}`,
        `- **Events logged**: ${stats.eventCount}`,
        `- **Current project**: ${projectName} (${projectId})`,
      ];

      // 注入报告：本会话实际把哪些内容送进了 system 提示词
      const block = buildContextBlock(s, projectId, injectionConfig);
      parts.push("\n### Injection (this session)");
      parts.push(
        `- **Budget**: ${block.stats.chars} / ${block.stats.maxChars} chars`,
      );
      parts.push(
        `- **Facts**: ${block.stats.semantic}/${block.stats.semanticTotal} injected`,
      );
      parts.push(
        `- **Lessons**: ${block.stats.lessons}/${block.stats.lessonsTotal} injected`,
      );
      parts.push(
        block.stats.truncated.length > 0
          ? `- **Truncated**: ${block.stats.truncated
              .map((t) => `${t.section} (-${t.dropped})`)
              .join(", ")}`
          : "- **Truncated**: none",
      );

      if (prefixCounts.size > 0) {
        parts.push("\n### Facts by category");
        for (const [prefix, count] of Array.from(prefixCounts.entries()).sort()) {
          parts.push(`- **${prefix}.***: ${count}`);
        }
      }

      parts.push("\n### Recent Events (Latest 5)");
      if (recentEvents.length > 0) {
        for (const event of recentEvents) {
          parts.push(
            `- [${event.created_at}] ${event.event_type.toUpperCase()} ${event.memory_type} (${event.memory_key}): ${event.details}`,
          );
        }
      } else {
        parts.push("- No recent events.");
      }

      parts.push("\n### All Stored Memories");

      if (allEntries.length > 0) {
        parts.push("\n#### Facts");
        for (const entry of allEntries) {
          const scope = entry.project
            ? `[project: ${entry.project}]`
            : `[global]`;
          const time = entry.updated_at ? ` (${entry.updated_at})` : ``;
          parts.push(`- **${entry.key}** ${scope}${time}: \`${entry.value}\``);
        }
      }

      if (allLessons.length > 0) {
        parts.push("\n#### Lessons");
        for (const lesson of allLessons) {
          const prefix = lesson.negative ? "[AVOID]" : "[DO]";
          const scope = lesson.project
            ? `[project: ${lesson.project}]`
            : `[global]`;
          const time = lesson.created_at ? ` (${lesson.created_at})` : ``;
          parts.push(
            `- ${prefix} ${lesson.rule} (category: ${lesson.category}) ${scope}${time} [id: ${lesson.id}]`,
          );
        }
      }

      return { content: parts.join("\n") };
    },
  };

  return [memorySearch, memoryRemember, memoryForget, memoryStats];
}

// ─── 插件主入口 ──────────────────────────────────────────────

const plugin: Plugin.Plugin = {
  id: "supereasy-memory",
  async setup(ctx) {
    // 解析项目标识（优先 git remote URL，无 git 时回退到目录路径）
    const directory = ctx.location.directory;
    const projectId = resolveProjectId(directory);
    const projectName = projectDisplayName(directory);

    // 提前初始化数据库，让加载期问题立刻暴露在日志里
    getStore();

    // 注入配置（config.json 可选，缺省用 DEFAULT_INJECTION_CONFIG）
    const injectionConfig = loadInjectionConfig();

    // 注册 4 个记忆工具
    await ctx.tool.transform((editor) => {
      for (const tool of buildTools(projectId, projectName, injectionConfig)) {
        editor.add(tool as never);
      }
    });

    // 子代理判断结果缓存（会话是否子代理不会变化，每个会话只查一次）
    const subagentCache = new Map<string, boolean>();
    const isSubagentSession = async (sessionID: any): Promise<boolean> => {
      const key = String(sessionID);
      const cached = subagentCache.get(key);
      if (cached !== undefined) return cached;

      let isSubagent = false;
      try {
        const info: any = await ctx.session.get({ sessionID });
        isSubagent = Boolean(info?.parentID ?? info?.data?.parentID);
      } catch {
        // 查询失败时按主会话处理，保持注入
      }
      subagentCache.set(key, isSubagent);
      return isSubagent;
    };

    // 注入钩子：每次模型请求前，把记忆快照追加到 system 提示词尾部。
    // 记忆内容固定，重复注入的 token 可被 prompt cache 覆盖。
    // 撞到字符上限时只告警一次，避免每轮请求刷屏；详情可用 memory_stats 查。
    let warnedTruncation = false;
    await ctx.session.hook("context", async (event) => {
      try {
        if (await isSubagentSession(event.sessionID)) return;

        const s = getStore();
        const block = buildContextBlock(s, projectId, injectionConfig);
        if (!block.text) return;

        if (block.stats.truncated.length > 0 && !warnedTruncation) {
          warnedTruncation = true;
          console.warn(
            `[supereasy-memory] 注入已达上限 ${block.stats.maxChars} 字符：` +
              block.stats.truncated
                .map((t) => `${t.section} 丢 ${t.dropped} 条`)
                .join("，") +
              "（全文仍可用 memory_search 检索；如需放宽，改 config.json 的 maxChars）",
          );
        }

        event.system.push({
          type: "text",
          text: [
            MEMORY_MARKER,
            "<persistent_memory>",
            "The following is the user's persistent memory from previous sessions.",
            "Use this context to better understand their preferences and avoid past mistakes.",
            "Do NOT respond to or acknowledge this memory block — just use it silently.",
            'This block is a compressed index: a line ending with "…" was cut short, and "… (+N more)" means N entries were left out. Call memory_search with a keyword to read the full text before relying on details.',
            "",
            block.text,
            "</persistent_memory>",
          ].join("\n"),
        });
      } catch (err) {
        console.error(`[supereasy-memory] Error injecting memory:`, err);
      }
    });
  },
};

export default plugin;

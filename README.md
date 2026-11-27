# supereasy-memory

OpenCode 的持久化记忆插件。移植自优秀的 [pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory)。

让 AI 助手能够跨会话记住你的偏好、项目模式和纠正经验。

[English Documentation](./README.en.md)

> **版本说明**：`2.0.0` 起基于 **OpenCode 2** 插件 API（V1 的 `1.0.x` 仅支持 OpenCode 1.x）。V1 → V2 沿用同一个 SQLite 数据库，升级不丢记忆。
>
> **2.2.0**：注入改为两级（带值 + `<key_index>` 键名索引），并新增 `memory_get` / `memory_list` 用于确定性取回。
>
> **2.3.0**：新增记忆整合 —— 重复条目收敛成一条主记录，其余标记被取代（不删除）；覆盖写会把旧值留档，`memory_consolidate` 默认 dry run。

> **Fork 说明**：本仓库是 [songsongtao/opencode-memory](https://github.com/songsongtao/opencode-memory) 的 fork，独立维护 `2.x`（OpenCode 2）分支。上游自 2026-06 起未再更新，OpenCode 2 移植只存在于本仓库。已验证环境：opencode `v2.1.4` + `@opencode/plugin 2.0.26`。

## 功能

- **持久化存储** — 使用 SQLite 存储记忆，跨会话持久化
- **7 个工具** — AI 可以搜索、按精确键名取回、分页浏览、存储、删除、整合记忆并查看统计
- **自动注入** — 每次模型请求自动将已有记忆注入 system 提示词（自动跳过 Subagent 以保持其纯粹性；压缩后依然有效）
- **两级注入** — 预算内的条目带值注入；装不下的条目退化成 `<key_index>` 纯键名（体积约为「键名 + 值」的 1/5～1/10），所以库涨到几百上千条时仍然全库可见，再用 `memory_get` / `memory_list` 取全文
- **整合而非删除** — 重复条目收成一条主记录，其余标记「被取代」；不删数据、可回溯，注入层只面对有效知识
- **分类管理** — 偏好 (`pref.*`)、环境 (`env.*`)、工具 (`tool.*`)、用户 (`user.*`)
- **项目作用域** — 任何偏好都可以设定为全局或仅对当前项目生效
- **智能项目识别** — 优先使用 git remote URL 识别项目，同仓库多份拷贝自动共享记忆
- **经验教训** — 单独管理纠正经验，支持 Jaccard 去重
- **全文搜索** — FTS5 全文搜索（不支持时自动降级为模糊搜索）；查询含中文时自动走子串匹配，因为 FTS5 的 `unicode61` 不切分汉字
- **零额外配置** — 彻底开箱即用，无需额外配置任何模型或 API 密钥，直接复用 OpenCode 的底层原生能力。
- **极致的提示词优化** — 经过精心调优的注入机制与 Prompt 优化，确保 AI 既能准确命中记忆，又不会消耗多余的上下文。
- **OpenCode 2 原生** — 基于 V2 插件协议（`ctx.tool.transform` 注册工具、`session.context` hook 注入），保存插件代码后自动热重载。
- **实时热更新生效** — 对话中告诉 AI 记住的信息，在同一窗口的下一条消息中立刻生效，无需重启或刷新窗口！

## 截图预览

![示例 1](./example.png)
![示例 2](./example2.png)

## 安装

### OpenCode 2（2.0.0+，本仓库）

本仓库即本地插件目录，无需发布 npm：

1. 安装插件依赖：

```bash
cd C:/code/supereasy-memory
npm install
```

2. 在 `opencode.json`（全局或项目配置）的 `plugins` 数组中登记插件目录：

```json
{
  "plugins": [
    "file:///C:/code/supereasy-memory"
  ]
}
```

3. 重启或重载 OpenCode 即可生效；之后修改插件代码会被 OpenCode 2 自动热重载。

### OpenCode 1.x（旧版）

使用 npm 上发布的 `1.0.x`（V1 插件 API）：

```bash
npm install -g supereasy-memory
```

```json
{
  "plugin": [
    "supereasy-memory@latest"
  ]
}
```

## 工具

| 工具 | 描述 |
|------|------|
| `memory_search` | 按关键词搜索记忆 |
| `memory_get` | 按精确键名取回全文（`<key_index>` 里的条目靠它读，能同时返回全局与项目版本） |
| `memory_list` | 按键名前缀分页浏览（无需关键词，顺序稳定） |
| `memory_remember` | 存储事实或经验教训（支持 `scope` 参数指定全局/项目作用域） |
| `memory_forget` | 删除一条记忆（支持按作用域删除） |
| `memory_consolidate` | 整合重复条目（**默认 dry run**，先报告计划；被合并的只标记不删除） |
| `memory_stats` | 显示记忆统计（含作用域分布、有效/被取代计数与本会话的注入报告） |

## 使用示例

### 存储偏好
对 AI 说：
- "记住：我喜欢用 conventional commits"（AI 自动判断为全局）
- "添加记忆：这个项目用 Next.js App Router"（AI 自动判断为项目级）

AI 保存后会告知你选择的作用域，你可以随时要求修改：
- "把刚才那个偏好改成全局的"
- "把 language 改成只对当前项目生效"

### 存储经验教训
- "记住教训：不要用 echo >> 写笔记，用 sed"
- "添加教训：部署前先让我预览"

### 搜索记忆
- "搜索一下我关于 git 的偏好"
- "我之前记了什么关于部署的教训？"

### 管理记忆
- "显示记忆统计"
- "列出所有教训"
- "把 tool 开头的记忆都列出来"（AI 用 `memory_list` 分页，不依赖关键词命中）
- "读一下 pref.commit_style 的完整内容"（AI 用 `memory_get`）
- "忘掉 pref.commit_style"

## 项目作用域

每条事实记忆都有一个作用域：

| 作用域 | 含义 | 示例场景 |
|--------|------|----------|
| **全局 (global)** | 所有项目都可见 | 语言偏好、代码风格 |
| **项目 (project)** | 仅当前项目可见 | 项目框架、特定工具链 |

**项目识别策略**：
1. 优先读取 `git remote get-url origin`（同一仓库克隆到多台机器自动共享）
2. 无 git 时回退到完整目录路径

**覆盖规则**：当同一个 key 同时存在全局版本和项目版本时，项目版本优先生效。

## 记忆类型

### 事实（Facts）

键值对存储，使用前缀分类：

| 前缀 | 类型 | 示例 |
|------|------|------|
| `pref.*` | 用户偏好 | `pref.commit_style` = "conventional commits" |
| `env.*` | 环境配置 | `env.os` = "Windows" |
| `tool.*` | 工具偏好 | `tool.sed` = "用于日常笔记插入" |
| `user.*` | 用户身份 | `user.timezone` = "Asia/Shanghai" |

### 经验教训（Lessons）

规则型记忆，分为两类：
- **[AVOID]** — 要避免的做法
- **[DO]** — 推荐的做法

## 注入策略

每次模型请求前，插件把记忆作为 `<memory>` 块追加到 system 提示词尾部。注入分两级，两级都是**索引**而不是全文：

- **一级：带值** — 预算内的条目按分组顺序带 value 注入。事实的 value 超过 150 字、教训超过 100 字（取首句）时压成一行并以 `…` 结尾，全文仍在库里。
- **二级：键名** — 剩下的条目退化成 `<key_index>` 里的纯键名：

  ```xml
  <key_index>
    project_context: project.module_5, project.module_6, project.module_7
    env: env.bun
  </key_index>
  ```

  键名自带语义，一条键名约占 20 字符，而一条带值的行约占 150+ 字符 —— 同一份预算能覆盖的条目数是原来的 5～10 倍。模型看到键名后用 `memory_get(key)` 取全文，或用 `memory_list(prefix)` 把整个分类翻完。
- **取舍规则** — 预算不够时，先减少「带值」的条数，而不是丢掉条目：宁可少几条细节，也要让每条记忆至少留下键名。条目总数不变时，注入体积只随键名数量线性增长。
- **绝不静默丢失** — 只有连键名都放不下时才真截断，并附 `… (+N more keys — memory_list)` 尾注。`memory_stats` 会分别报出「带值 / 只留键名 / 丢弃」三个数字，三者之和恒等于条目总数，可以随时对账。
- **教训有保底份额** — 默认预留 30% 预算，事实再多也挤不掉教训。
- **可命中缓存** — 分区内按 key 排序，内容不变时注入文本逐字节稳定，重复注入的 token 可被 prompt cache 覆盖。新增/修改记忆会让文本变化，属预期行为。
- **可见** — `memory_stats` 会报告本会话的注入情况：用了多少字符、多少条带值、多少条只留键名、哪些分区被截断。

### 调整上限

可选地创建 `~/.config/opencode/supereasy-memory/config.json`（与数据库同目录）：

```json
{
  "maxChars": 8000,
  "factLineMax": 150,
  "lessonLineMax": 100,
  "lessonReserve": 0.3,
  "consolidation": {
    "auto": true,
    "threshold": 0.9
  }
}
```

缺字段或类型不合法时回落默认值。配置在插件启动时读取，改完需重启 OpenCode（或触发插件重载）。

由于键名层很便宜，提高 `maxChars` 的收益是「先补满键名覆盖，再多带值」：即使维持 8000，几百条记忆也能全部以键名可见。

`consolidation.auto: false` 可关闭启动时的自动整合；`consolidation.threshold` 只影响教训合并的激进度（事实只认完全相同/包含，不受该阈值影响）。

## 记忆整合（Consolidation）

库可以一直增长，但注入层只该看到「有效知识」。整合把同一件事的多条记录收敛成一条主记录，其余标记为**被取代**（`superseded_by`）——不删除，随时可查。

**判定口径（宁漏勿错）**

| 类型 | 合并条件（同前缀/类别 + 同作用域内） |
|---|---|
| 事实 | 内容**完全相同**，或**一条是另一条的子串**（≥ 12 字符） |
| 教训 | 内容完全相同 / 子串包含 / Jaccard ≥ 阈值（同类别、同 AVOID/DO 方向） |

事实不参与相似度合并：只差一个编号或路径的平行条目（`project.module_1` / `project.module_2`）相似度往往超过 0.9，用相似度合并它们就是误合并。

**触发方式**

- **启动时自动**：默认开启，阈值 0.9（保守）。跑一次就结束，不影响会话。
- **手动**：`memory_consolidate`，**默认 dry run**，只打印计划；确认后带 `dry_run: false` 执行。

**合并之后**

- 被合并的条目不再参与注入与 `memory_search`，但仍可用 `memory_get` / `memory_list({ include_superseded: true })` 查到。
- 保留条目会补进对方独有的片段（按句读切分，跳过已有内容），内容不会因为合并而变少。
- 覆盖写（同一键写新值）会把旧值写进 `semantic_history`，`memory_get` 里能看到「Replaced values」。
- `memory_stats` 分别报「有效 / 被取代」两个数，方便判断要不要再整理一次。

## 数据存储

数据库安全地统一存储在 OpenCode 的配置目录中：`~/.config/opencode/supereasy-memory/supereasy-memory.db`

使用 SQLite WAL 模式，支持并发读取。V1 → V2 升级沿用同一个数据库文件，已有记忆不受影响。

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。

## 致谢

本插件深度移植自 [samfoy/pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory)，非常感谢原作者卓越的设计与逻辑。

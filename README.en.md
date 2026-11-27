# supereasy-memory

Persistent memory plugin for OpenCode, ported from the excellent [pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory).

This extension gives your AI assistant the ability to remember your preferences, project patterns, and corrections across sessions.

[中文文档](./README.md)

> **Version note**: `2.0.0` and later target the **OpenCode 2** plugin API (the `1.0.x` line only supports OpenCode 1.x). Both lines share the same SQLite database, so upgrading keeps all memories.
>
> **2.2.0**: injection became two-level (values + a `<key_index>` of keys), and `memory_get` / `memory_list` were added for deterministic retrieval.
>
> **2.3.0**: memory consolidation — duplicates collapse into one canonical entry, the rest are marked superseded (not deleted); overwrites archive the old value, and `memory_consolidate` is a dry run by default.
>
> **2.3.1**: large-library injection fix (list as many keys as fit instead of dropping the whole index); lesson deduplication is scoped to the same category/direction/scope and no longer rejects parallel rules that differ only by an index; `memory_forget` is now a real delete (history and event-log values included); injected content neutralizes block markers and sanitizes tag names; `memory_stats` has a character cap and `memory_list` supports `type: "lesson"`.

> **Fork note**: This is a fork of [songsongtao/opencode-memory](https://github.com/songsongtao/opencode-memory), maintaining the `2.x` (OpenCode 2) line independently. Upstream has been dormant since 2026-06, and the OpenCode 2 port exists only here. Verified against opencode `v2.1.4` + `@opencode/plugin 2.0.26`.

## Features

- **Persistent Storage** — Uses SQLite to store memories, ensuring they persist across different OpenCode sessions.
- **7 Built-in Tools** — The AI can search, fetch by exact key, page through categories, store, delete, consolidate memories, and inspect statistics.
- **Auto-Injection** — Injects existing memories into the system prompt on every model request (subagent sessions are skipped to keep their context pure; injection survives compaction).
- **Two-Level Injection** — Entries that fit are injected with their value; the rest degrade to key-only entries in `<key_index>` (about 1/5–1/10 the size of key + value). At the 8000-character default, roughly 500 ordinary keys (~13 chars) or 160 long keys (~50 chars) are listed; beyond that it still lists as many as fit instead of dropping the whole index. `memory_get` / `memory_list` fetch the full text.
- **Consolidation Instead of Deletion** — Duplicates collapse into one canonical entry and the rest are marked superseded: nothing is deleted, everything stays traceable, and injection only faces effective knowledge.
- **Forget Means Delete** — Only an explicit "forget this" removes data permanently (including overwrite history and the value inside the event log); consolidation never deletes.
- **Smart Categorization** — Memories are grouped into preferences (`pref.*`), environment (`env.*`), tools (`tool.*`), and user (`user.*`).
- **Project Scoping** — Any preference can be global (applies everywhere) or scoped exclusively to the current project.
- **Intelligent Project Detection** — Uses git remote URLs to identify projects, automatically sharing memory across multiple clones of the same repository.
- **Lessons Learned** — Manages corrections and lessons separately; similarity deduplication is scoped to the same category, direction and scope, so parallel rules that differ only by an index are not rejected.
- **Full-Text Search** — Powered by FTS5 full-text search (with graceful fallback to fuzzy matching); queries containing Chinese/Japanese/Korean text use substring matching instead, since FTS5's `unicode61` tokenizer does not split CJK runs.
- **Zero Configuration** — No need to configure external models or API keys; it runs seamlessly using OpenCode's native environment.
- **Optimized Prompts** — Carefully tuned system prompts and injection mechanisms ensure the AI effectively utilizes the memory without degrading conversational quality.
- **Native OpenCode 2** — Built on the V2 plugin protocol (`ctx.tool.transform` for tools, `ctx.session.hook("context")` for injection); plugin code hot-reloads on save.
- **Real-time Hot Updates** — Memories taught to the AI mid-conversation take effect instantly on the very next message without needing to restart or reload the window!

## Screenshots

![Example 1](./example.png)
![Example 2](./example2.png)

## Installation

### OpenCode 2 (2.0.0+, this repository)

This repository is the local plugin directory; no npm publish is needed:

1. Install the plugin dependencies:

```bash
cd C:/code/supereasy-memory
npm install
```

2. Register the plugin directory in the `plugins` array of `opencode.json` (global or project config):

```json
{
  "plugins": [
    "file:///C:/code/supereasy-memory"
  ]
}
```

3. Restart or reload OpenCode. Afterwards, edits to the plugin code are hot-reloaded by OpenCode 2 automatically.

### OpenCode 1.x (legacy)

Use the published `1.0.x` package (V1 plugin API):

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

## Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search semantic memory by keyword. |
| `memory_get` | Fetch the full text by exact key (this is how `<key_index>` entries are read; returns both global and project versions). |
| `memory_list` | Page through memory: facts by key prefix, or `type: "lesson"` to list lessons (with id and scope). |
| `memory_remember` | Store a fact or lesson (supports `scope` for global vs. project). |
| `memory_forget` | Permanently delete a memory (including overwrite history; the value in the event log becomes `[redacted]`; supports scope deletion). |
| `memory_consolidate` | Merge duplicate entries (**dry run by default**; merged entries are marked, not deleted). |
| `memory_stats` | View memory statistics, effective/superseded counts, and this session's injection report (summarized when the library is large). |

## Usage Examples

### Storing Preferences
Tell the AI:
- *"Remember: I prefer conventional commits."* (AI defaults to global scope)
- *"Add memory: use Next.js App Router for this project."* (AI defaults to project scope)

### Storing Lessons
- *"Remember the lesson: don't use `echo >>` for writing notes, use `sed` instead."*
- *"Add lesson: always show me a preview before deploying."*

### Searching & Managing Memory
- *"Search for my preferences regarding git."*
- *"What lessons have I recorded about deployment?"*
- *"List every memory starting with tool."* (the AI pages with `memory_list`, no keyword needed)
- *"Show me the full text of pref.commit_style."* (the AI calls `memory_get`)
- *"Show memory stats."*
- *"Forget pref.commit_style."*

## Project Scope Rules

Every memory fact has a scope:

| Scope | Description | Use Cases |
|-------|-------------|-----------|
| **Global** | Visible across all projects | Language preferences, general coding style |
| **Project** | Visible only in the current project | Project framework, specific toolchains |

**Project Identification Strategy:**
1. Prioritizes `git remote get-url origin` (this allows different clones of the same repo to share memory).
2. Falls back to the full directory path if git is not available.

*Note: If the same key exists in both Global and Project scopes, the Project scope takes precedence.*

## Injection Strategy

Before every model request the plugin appends a `<memory>` block to the end of the system prompt. Injection has two levels, and neither is the full text:

- **Level 1 — values** — entries that fit are injected with their value. A fact value over 150 characters, or a lesson over 100 characters (first sentence), is collapsed to one line ending with `…`; the full text stays in the database.
- **Level 2 — keys** — the remaining entries degrade to key-only entries in `<key_index>`:

  ```xml
  <key_index>
    project_context: project.module_5, project.module_6, project.module_7
    env: env.bun
  </key_index>
  ```

  A key carries meaning on its own. One key costs about 20 characters where a value line costs 150+, so the same budget covers 5–10× more entries. The model reads a key with `memory_get(key)` or pages a whole category with `memory_list(prefix)`.
- **Trade-off rule** — when the budget is short, the plugin drops value lines first, never entries: fewer details beats losing a memory. With a fixed entry count, the block only grows with the number of keys.
- **When even all keys do not fit** — list as many as possible in priority/alphabetical order (at the 8000 default: about 500 ordinary keys, or 160 long ~50-character keys), then add a `… (+N more keys — memory_list)` trailer. The key index is never thrown away just because it cannot fit in full.
- **Nothing disappears silently** — `memory_stats` reports values / keys / dropped separately, and the three always add up to the total entry count.
- **Lessons keep a guaranteed share** — 30% of the budget is reserved by default, so facts cannot starve them.
- **Cache friendly** — sections are sorted by key, so the injected text is byte-stable while memories do not change and can hit the prompt cache. Adding or editing a memory changes the text, as expected.
- **Visible** — `memory_stats` reports what the current session injects: characters used, how many entries carry values, how many are keys only, and which sections were truncated.

### Tuning the budget

Optionally create `~/.config/opencode/supereasy-memory/config.json` (next to the database):

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

Missing fields or invalid types fall back to the defaults. The file is read at plugin startup, so restart OpenCode (or trigger a plugin reload) after editing it.

Since the key layer is cheap, raising `maxChars` first fills out key coverage and only then adds more values: at the 8000 default, about 500 ordinary keys stay visible.

`consolidation.auto: false` disables the startup merge; `consolidation.threshold` only affects how aggressively lessons merge (facts only merge on identity/containment and ignore the threshold).

## Consolidation

The library may grow forever, but injection should only see **effective** knowledge. Consolidation collapses several records of the same thing into one canonical entry and marks the rest superseded (`superseded_by`) — nothing is deleted, everything stays traceable.

**Criteria (prefer missing a merge over a wrong one)**

| Kind | Merged when (same prefix/category and same scope) |
|---|---|
| Fact | Content is **identical**, or **one is a substring of the other** (≥ 12 chars) |
| Lesson | Identical / substring / Jaccard ≥ threshold (same category and same AVOID/DO direction) |

Facts never merge by similarity: parallel entries that differ only by an index or a path (`project.module_1` vs `project.module_2`) often score above 0.9, and merging them would be a false positive.

**When it runs**

- **Automatically at startup**: on by default, threshold 0.9 (conservative). It runs once and does not touch the session.
- **Manually**: `memory_consolidate`, a **dry run by default** that only prints the plan; call again with `dry_run: false` to apply.

**After merging**

- Merged entries stop feeding injection and `memory_search` but remain readable via `memory_get` / `memory_list({ include_superseded: true })`.
- The canonical entry picks up fragments unique to the others (split on sentence punctuation, existing content skipped), so merging does not lose content.
- Overwriting a key with `memory_remember` archives the old value in `semantic_history`; `memory_get` shows them under "Replaced values" (with scope labels).
- `memory_stats` reports effective vs superseded counts, so you can tell whether another tidy-up is worthwhile.

## Forget

`memory_forget` is a **permanent delete**, separate from consolidation:

- the fact/lesson row is removed;
- old values in `semantic_history` for that key are removed;
- the value inside the event log is replaced with `[redacted]` (the event rows remain).

In other words: **consolidation never deletes anything; only an explicit "forget this" removes data**, and nothing can read it back afterwards. Lessons soft-deleted by older versions (2.3.0 and earlier, `is_deleted = 1`) are physically removed on the first 2.3.1 startup — they were content the user asked to forget.

## Data Storage

Database is safely stored within OpenCode's configuration directory: `~/.config/opencode/supereasy-memory/supereasy-memory.db`

Uses SQLite in WAL mode to support concurrent reads. The V1 → V2 upgrade reuses the same database file, so existing memories are preserved.

Besides `semantic` / `lessons` / `events`, there is an append-only `semantic_history`: when a key is overwritten, the old value is archived there (not injected or searched) and `memory_get` can show it.

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgements

This plugin is a port of [samfoy/pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory). Special thanks to the original author for the incredible design and logic.

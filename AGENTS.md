# OpenCode Memory - Agent Guidelines

## 🤖 Context for AI Agents
You are working on the `supereasy-memory` plugin, a persistent memory extension for OpenCode AI. This file provides you with the critical context needed to understand, modify, and deploy this codebase correctly.

## ⚠️ MANDATORY RULE: Documentation Sync
**ANY TIME you modify the logic, tools, or behavior of this plugin, you MUST simultaneously update `README.md` and `README.en.md`!**

Never leave the documentation out of sync with the implementation.

---

## 🛠️ Project Structure & Architecture

This is a Bun-based TypeScript project. 
The database uses `bun:sqlite` with local SQLite storage.

### Core Files
- `index.ts`: The main plugin entry point. It exports a V2 plugin definition (`{ id, setup }`) containing all the Tool definitions (`memory_remember`, `memory_search`, etc.) and the session hook (`ctx.session.hook("context")`, which injects memory into the system prompt on every model request).
- `store.ts`: The SQLite data access layer. It handles migrations, FTS5 full-text search, and the Jaccard similarity algorithm for deduplicating lessons.
- `injector.ts`: The context injection layer. It reads memories from the store and formats them into an 8KB-limited XML block (`<persistent_memory>`) with dynamic grouping based on key prefixes.
- `test.ts`: The primary test suite.
- `package.json`: Contains the project metadata. No external runtime dependencies are allowed.

---

## 💻 How to Modify the Project

1. **Keep it Dependency-Free**: Do not add runtime NPM dependencies unless absolutely necessary. Rely on Bun's built-in modules (`bun:sqlite`, `node:path`, etc.).
2. **Database Schema Changes**: If you modify the SQLite schema in `store.ts`, remember that SQLite in Bun handles synchronous execution. Be careful with migrations as `bun:sqlite` does not support complex async migration flows out of the box.
3. **Context Injection Safety**: 
   - If you modify `injector.ts`, ensure the output stays within the injection budget (`maxChars`, 8000 by default; configurable in `config.json`). Failing to do so will cause the LLM context window to overflow and break the user's OpenCode session.
   - The injection in `ctx.session.hook("context")` must only apply to the main agent. It automatically identifies subagents by checking if the session has a `parentID` via `ctx.session.get`, and skips memory injection for them to keep their context pure.
4. **Testing**: 
   - After making changes, ALWAYS run the test suite: `bun test.ts` (it is a plain script, not `bun test`).
   - Ensure you haven't broken the FTS5 search or Jaccard similarity threshold tests.

---

## 🚀 How to Deploy / Run

This directory (`C:\code\supereasy-memory`) **is** the plugin: OpenCode loads it directly from source. There is no npm publish step (see README: "本仓库即本地插件目录，无需发布 npm").

1. **Local Live Testing**:
   Register the directory in `~/.config/opencode/opencode.json` under `plugins`:
   ```json
   { "plugins": ["file:///C:/code/supereasy-memory"] }
   ```
   Code changes hot-reload; press `Ctrl/Cmd + R` to force a reload.
2. **Versioning**:
   - `package.json`'s version is a local marker only; bump it when the behavior changes.
   - Do not run `npm publish` unless the user explicitly asks for a release.

---

## 🧠 Using the Plugin (from the AI's perspective)
When the user installs this plugin, they gain 7 tools:
- `memory_remember`: Upserts facts or records lessons.
- `memory_search`: Full-text search across facts and lessons (results include lesson ids and scopes).
- `memory_get`: Fetches the full text of a fact by exact key (this is how `<key_index>` entries are read).
- `memory_list`: Pages through facts by key prefix, or lessons with `type: "lesson"`.
- `memory_consolidate`: Merges near-duplicates; marked superseded, never deleted; dry run by default.
- `memory_stats`: Retrieves DB metrics, the injection report, and stored memories (summarized when large).
- `memory_forget`: Permanently deletes a fact or lesson (including overwrite history; the event-log value becomes `[redacted]`).

If the user gives you an instruction like "Remember that I prefer TypeScript," you should proactively invoke the `memory_remember` tool. **You do not need to ask for permission to remember things if the user explicitly commanded you to do so.**


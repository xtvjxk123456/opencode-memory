/**
 * 针对 supereasy-memory 存储层与注入层的简单测试脚本。
 * 运行方式: bun run test.ts
 */
import { MemoryStore } from "./store.js";
import { buildContextBlock, resolveProjectId } from "./injector.js";
import { estimateDumpChars, STATS_DUMP_MAX_CHARS } from "./index.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

// 定义测试用数据库的绝对路径
const TEST_DB = join(import.meta.dir, "data", "test-memory.db");

// 运行前先清理可能存在的旧测试数据库文件，确保测试环境纯净
try {
  rmSync(TEST_DB, { force: true });
  rmSync(TEST_DB + "-wal", { force: true });
  rmSync(TEST_DB + "-shm", { force: true });
} catch {}

console.log("=== supereasy-memory 测试套件 ===\n");

// 测试 1: 初始化数据库存储实例
console.log("1. 创建 MemoryStore 实例...");
const store = new MemoryStore(TEST_DB);
console.log("   ✓ 数据库存储实例创建成功\n");

// 测试 2: 新增（插入或更新）事实记忆 (Semantic entries)
console.log("2. 测试 upsertSemantic (新增事实记忆)...");
store.upsertSemantic("pref.commit_style", "conventional commits", 0.95, "user");
store.upsertSemantic("pref.code_style", "functional over OOP", 0.9, "user");
store.upsertSemantic("tool.sed", "use for daily note insertion", 0.85, "user");
store.upsertSemantic("user.timezone", "Asia/Shanghai", 0.99, "user");
store.upsertSemantic("project.myapp.framework", "Next.js App Router", 0.9, "user");

const allEntries = store.getAllSemantic();
console.log(`   ✓ 成功插入了 ${allEntries.length} 条记录`);
if (allEntries.length !== 5) {
  console.error("   ✗ 预期应该有 5 条记录！");
  process.exit(1);
}
console.log();

// 测试 3: 搜索事实记忆
console.log("3. 测试 searchSemantic (搜索事实记忆)...");
const commitResults = store.searchSemantic("commit", 5);
console.log(`   找到了 ${commitResults.length} 条包含 "commit" 的结果`);
if (commitResults.length === 0) {
  console.error("   ✗ 预期至少应该找到 1 条包含 'commit' 的结果！");
  process.exit(1);
}
console.log(`   ✓ 第一条结果: ${commitResults[0].key} = ${commitResults[0].value}`);
console.log();

// 测试 4: 按前缀分页列出事实（memory_list 背后的接口）
console.log("4. 测试 listSemanticPage (按前缀分页)...");
store.upsertSemantic("preferences.theme", "dark", 0.9, "user"); // 前缀相近但不应被 "pref" 命中
const prefixPage = store.listSemanticPage("pref", 0, 10);
console.log(`   "pref" 前缀命中 ${prefixPage.total} 条: ${prefixPage.entries.map((e) => e.key).join(", ")}`);
if (prefixPage.total !== 2 || !prefixPage.entries.every((e) => e.key.startsWith("pref."))) {
  console.error('   ✗ "pref" 应只命中 pref.*，不能命中 preferences.*！');
  process.exit(1);
}
if (prefixPage.entries[0]!.key > prefixPage.entries[1]!.key) {
  console.error("   ✗ 前缀结果没有按 key 排序（翻页顺序不稳定）！");
  process.exit(1);
}
if (store.listSemanticPage("no.such", 0, 10).total !== 0) {
  console.error("   ✗ 不存在的前缀应该返回 0 条！");
  process.exit(1);
}
store.deleteSemantic("preferences.theme");
console.log(`   ✓ 前缀匹配有边界，结果有序\n`);

// 测试 5: 更新现有的事实记忆
console.log("5. 测试 upsert (更新现有记录)...");
store.upsertSemantic("pref.commit_style", "gitmoji style", 0.8, "user");
const updated = store.getAllSemantic().find((e) => e.key === "pref.commit_style");
if (updated?.value !== "gitmoji style") {
  console.error("   ✗ 预期记录的值应该被更新！");
  process.exit(1);
}
console.log(`   ✓ 成功更新: ${updated.key} = ${updated.value}\n`);

// 测试 6: 删除事实记忆
console.log("6. 测试 deleteSemantic (删除事实记忆)...");
const deleted = store.deleteSemantic("pref.code_style");
if (!deleted) {
  console.error("   ✗ 预期删除操作应该返回 true！");
  process.exit(1);
}
const afterDelete = store.getAllSemantic();
console.log(`   ✓ 成功删除。剩余记录数: ${afterDelete.length}\n`);

// 测试 7: 增加经验教训 (Lessons)
console.log("7. 测试 addLesson (新增经验教训)...");
const lessonId1 = store.addLesson("Use sed for daily note insertion, not echo >>", "tools", true, "user");
const lessonId2 = store.addLesson("Draft wiki changes before publishing", "deployment", false, "user");
console.log(`   ✓ 成功新增教训 1: ${lessonId1}`);
console.log(`   ✓ 成功新增教训 2: ${lessonId2}`);

// 测试完全重复的教训拦截
const dupId = store.addLesson("Use sed for daily note insertion, not echo >>", "tools", true, "user");
if (dupId !== null) {
  console.error("   ✗ 预期完全一致的重复教训应该被拦截！");
  process.exit(1);
}
console.log("   ✓ 完全重复的教训被正确拦截");

// 测试 Jaccard 相似度算法去重 (相似度阈值是 0.7)
// 下面这句话与第一条教训高度相似（重合度很大）
const similarId = store.addLesson("Use sed for daily note insertion, not echo append", "tools", true, "user");
if (similarId !== null) {
  console.error("   ✗ 预期高度相似的教训应该被拦截！");
  process.exit(1);
}
console.log("   ✓ 高度相似的教训被正确拦截 (Jaccard >= 0.7)");
console.log();

// 测试 8: 获取所有经验教训
console.log("8. 测试 getLessons (获取经验教训)...");
const lessons = store.getLessons();
console.log(`   找到了 ${lessons.length} 条教训`);
if (lessons.length !== 2) {
  console.error("   ✗ 预期应该有 2 条教训！");
  process.exit(1);
}
console.log(`   ✓ 教训 1: [${lessons[0].negative ? "AVOID" : "DO"}] ${lessons[0].rule}`);
console.log(`   ✓ 教训 2: [${lessons[1].negative ? "AVOID" : "DO"}] ${lessons[1].rule}`);
console.log();

// 测试 9: 删除经验教训
console.log("9. 测试 deleteLesson (删除经验教训)...");
const lessonDeleted = store.deleteLesson(lessonId2!);
if (!lessonDeleted) {
  console.error("   ✗ 预期删除操作应该返回 true！");
  process.exit(1);
}
const afterLessonDelete = store.getLessons();
console.log(`   ✓ 成功删除。剩余教训数: ${afterLessonDelete.length}\n`);

// 测试 10: 获取数据库统计信息
console.log("10. 测试 getStats (获取统计数据)...");
const stats = store.getStats();
console.log(`   ✓ 事实数量: ${stats.semanticCount}, 教训数量: ${stats.lessonCount}, 事件数量: ${stats.eventCount}\n`);

// 测试 11: 构建上下文注入块 (Context Block)
console.log("11. 测试 buildContextBlock (生成 XML 上下文块)...");
// 重新加回一些记录用于测试 XML 生成
store.upsertSemantic("pref.commit_style", "conventional commits", 0.95, "user");
const block = buildContextBlock(store, "/home/user/projects/myapp");
console.log(`   注入块统计: 包含 ${block.stats.semantic} 条事实, ${block.stats.lessons} 条教训`);
console.log(`   注入块长度: ${block.text.length} 字符`);
if (!block.text.includes("<memory>")) {
  console.error("   ✗ 预期 XML 应该包含 <memory> 标签！");
  process.exit(1);
}
if (!block.text.includes("<preferences>")) {
  console.error("   ✗ 预期 XML 应该包含 <preferences> 分组！");
  process.exit(1);
}
console.log("   ✓ 注入块包含了预期的 XML 结构");
console.log(`\n--- 注入上下文预览 ---\n${block.text}\n--- 预览结束 ---\n`);

// 测试 12: 解析项目标识 (Project Id)
console.log("12. 测试 resolveProjectId (解析项目唯一标识)...");
console.log(`   "/home/user/projects/my-app" → "${resolveProjectId("/home/user/projects/my-app")}"`);
console.log(`   "C:\\Users\\HP\\project\\openc" → "${resolveProjectId("C:\\Users\\HP\\project\\openc")}"`);
console.log(`   ✓ 项目标识解析功能正常\n`);

// 测试 13: 搜索经验教训
console.log("13. 测试 searchLessons (搜索经验教训)...");
const lessonSearch = store.searchLessons("sed", 5);
console.log(`   找到了 ${lessonSearch.length} 条包含 "sed" 的教训`);
if (lessonSearch.length === 0) {
  console.error("   ✗ 预期至少应该找到 1 条包含 'sed' 的教训！");
  process.exit(1);
}
console.log(`   ✓ 第一条结果: ${lessonSearch[0].rule}\n`);

// 测试 14: 两级注入（值 + 键名索引）在长期膨胀的库上仍然不丢条目
console.log("14. 测试两级注入与键名索引...");
for (let i = 0; i < 60; i++) {
  // 每条 600+ 字，模拟实际库里的长笔记
  store.upsertSemantic(`tool.bulk_${i}`, `bulk value ${i} ` + "长".repeat(600), 0.9, "user");
}
for (let i = 0; i < 30; i++) {
  store.addLesson(
    `bulk lesson ${i} token${i} — verify before answering`,
    "bulk",
    false,
    "user",
  );
}
const bigBlock = buildContextBlock(store, undefined);
console.log(
  `   注入块: ${bigBlock.stats.chars}/${bigBlock.stats.maxChars} 字符, 带值 ${bigBlock.stats.semantic}, 键名 ${bigBlock.stats.keys}, 事实共 ${bigBlock.stats.semanticTotal}, 教训 ${bigBlock.stats.lessons}/${bigBlock.stats.lessonsTotal}`,
);
console.log(`   被截断的分区: ${JSON.stringify(bigBlock.stats.truncated)}`);
if (bigBlock.stats.chars > bigBlock.stats.maxChars) {
  console.error("   ✗ 注入块超过了字符上限！");
  process.exit(1);
}
if (bigBlock.stats.lessons === 0) {
  console.error("   ✗ 教训被事实挤没了（保底份额失效）！");
  process.exit(1);
}
if (!bigBlock.text.includes("<lessons>")) {
  console.error("   ✗ 预期应该包含 <lessons> 分区！");
  process.exit(1);
}
// 超预算的条目必须退化成键名，而不是消失
if (bigBlock.stats.keys === 0 || !bigBlock.text.includes("<key_index>")) {
  console.error("   ✗ 超出预算的事实应该退化成 <key_index> 键名！");
  process.exit(1);
}
for (let i = 0; i < 60; i++) {
  // 带值的行用 humanizeKey 把 tool.bulk_3 变成 "bulk 3"；键名索引里是完整键名
  const inline = bigBlock.text.includes(`bulk ${i}:`);
  const indexed = bigBlock.text.includes(`bulk_${i}`);
  if (!inline && !indexed) {
    console.error(`   ✗ 键名 tool.bulk_${i} 在注入块里完全找不到！`);
    process.exit(1);
  }
}
// 账要能对上：带值 + 只有键名 + 连键名都没放下 = 事实总数
const dropped = bigBlock.stats.truncated
  .filter((t) => t.section === "key_index")
  .reduce((n, t) => n + t.dropped, 0);
if (bigBlock.stats.semantic + bigBlock.stats.keys + dropped !== bigBlock.stats.semanticTotal) {
  console.error("   ✗ 事实条数对不上（有条目既没带值也没留键名）！");
  process.exit(1);
}
// 稳定性：内容不变时两次构建结果必须一致（prompt cache 友好）
if (buildContextBlock(store, undefined).text !== bigBlock.text) {
  console.error("   ✗ 两次构建的注入文本不一致！");
  process.exit(1);
}
console.log("   ✓ 超限时值降级为键名 + 保底教训 + 条数可对账 + 输出稳定\n");

// 测试 15: 自定义上限
console.log("15. 测试自定义 maxChars...");
const tightBlock = buildContextBlock(store, undefined, {
  maxChars: 3000,
  factLineMax: 150,
  lessonLineMax: 100,
  lessonReserve: 0.3,
});
console.log(`   3000 上限下: ${tightBlock.stats.chars} 字符, 教训 ${tightBlock.stats.lessons} 条`);
if (tightBlock.stats.chars > 3000) {
  console.error("   ✗ 自定义上限没有生效！");
  process.exit(1);
}
if (tightBlock.stats.lessons === 0) {
  console.error("   ✗ 自定义上限下教训被挤没了！");
  process.exit(1);
}
console.log("   ✓ 自定义上限生效\n");

// 测试 16: 中文教训去重（分词不能因为过滤掉中文而变成空集）
console.log("16. 测试中文教训去重...");
const cjk1 = store.addLesson("部署前先让我预览再发布", "deployment", false, "user");
const cjk2 = store.addLesson("写中文文档前先确认目标读者", "writing", false, "user");
const cjk3 = store.addLesson("部署前先让我预览再发布内容", "deployment", false, "user");
if (!cjk1 || !cjk2) {
  console.error("   ✗ 两条不同的中文教训都应该被接受（纯中文被误判为重复）！");
  process.exit(1);
}
if (cjk3 !== null) {
  console.error("   ✗ 高度相似的中文教训应该被拦截！");
  process.exit(1);
}
console.log("   ✓ 不同的中文教训可入库，近似的中文教训被拦截\n");

// 测试 17: 中文关键词检索（FTS5 的 unicode61 不切分汉字，必须走 LIKE 兜底）
console.log("17. 测试中文关键词检索...");
store.upsertSemantic("pref.语言", "中文优先，注释用中文", 0.9, "user");
const cnLessons = store.searchLessons("部署", 5);
const cnSingle = store.searchLessons("部", 5);
const cnFacts = store.searchSemantic("中文", 5);
const enStillOk = store.searchSemantic("commit", 5);
console.log(`   "部署" → ${cnLessons.length} 条教训, "部" → ${cnSingle.length} 条, "中文" → ${cnFacts.length} 条事实`);
if (cnLessons.length === 0) {
  console.error("   ✗ 中文关键词检索 0 命中（CJK 应走 LIKE 兜底）！");
  process.exit(1);
}
if (cnSingle.length === 0) {
  console.error("   ✗ 单个汉字也应能命中！");
  process.exit(1);
}
if (cnFacts.length === 0) {
  console.error("   ✗ 中文事实检索 0 命中！");
  process.exit(1);
}
if (enStillOk.length === 0) {
  console.error("   ✗ 英文检索被破坏了！");
  process.exit(1);
}
console.log("   ✓ 中文（含单字）走 LIKE 命中，英文仍走 FTS 正常\n");

// 测试 18: 收紧预算后账仍然对得上（不静默丢条目）
console.log("18. 测试收紧预算后的条目对账...");
for (const maxChars of [4000, 2500, 1500]) {
  const b = buildContextBlock(store, undefined, {
    maxChars,
    factLineMax: 150,
    lessonLineMax: 100,
    lessonReserve: 0.3,
  });
  const drop = b.stats.truncated
    .filter((t) => t.section === "key_index")
    .reduce((n, t) => n + t.dropped, 0);
  console.log(
    `   ${maxChars} 上限: ${b.stats.chars} 字符, 带值 ${b.stats.semantic}, 键名 ${b.stats.keys}, 丢弃 ${drop}, 教训 ${b.stats.lessons}`,
  );
  if (b.stats.chars > maxChars) {
    console.error(`   ✗ ${maxChars} 上限被突破！`);
    process.exit(1);
  }
  if (b.stats.semantic + b.stats.keys + drop !== b.stats.semanticTotal) {
    console.error(`   ✗ ${maxChars} 上限下有条目既没带值也没留键名，账对不上！`);
    process.exit(1);
  }
  if (drop > 0 && !b.text.includes("more keys — memory_list")) {
    console.error(`   ✗ ${maxChars} 上限下有丢弃，却没有留下约定数量的尾注！`);
    process.exit(1);
  }
}
if (!buildContextBlock(store, undefined, { maxChars: 1500, factLineMax: 150, lessonLineMax: 100, lessonReserve: 0.3 }).stats.lessons) {
  console.error("   ✗ 收紧到 1500 时教训保底失效！");
  process.exit(1);
}
console.log("   ✓ 任意预算下 带值 + 键名 + 丢弃 = 总数\n");

// 测试 19: memory_get / memory_list 背后的取回接口
console.log("19. 测试确定性取回 (getSemanticByKey / listSemanticPage)...");
store.upsertSemantic("pref.theme", "dark", 0.9, "user");
store.upsertSemantic("pref.theme", "light", 0.9, "user", "project-x");
const themeRows = store.getSemanticByKey("pref.theme");
console.log(`   pref.theme 取回 ${themeRows.length} 条: ${themeRows.map((r) => r.project ?? "global").join(", ")}`);
if (themeRows.length !== 2) {
  console.error("   ✗ 同一 key 的全局 + 项目版本都应该取回！");
  process.exit(1);
}
if (themeRows[0].project !== "project-x") {
  console.error("   ✗ 项目级版本应该排在前面（覆盖关系最具体）！");
  process.exit(1);
}
if (store.getSemanticByKey("no.such.key").length !== 0) {
  console.error("   ✗ 不存在的 key 应该返回空数组！");
  process.exit(1);
}

const page1 = store.listSemanticPage("tool.bulk_", 0, 5);
const page2 = store.listSemanticPage("tool.bulk_", 5, 5);
const prefPage = store.listSemanticPage("pref", 0, 100);
console.log(
  `   tool.bulk_ 共 ${page1.total} 条, 第一页 ${page1.entries.length} 条, 第二页首条 ${page2.entries[0]?.key}`,
);
if (page1.total !== 60 || page1.entries.length !== 5) {
  console.error("   ✗ 分页数量不对！");
  process.exit(1);
}
if (page1.entries[0].key === page2.entries[0].key) {
  console.error("   ✗ offset 没有生效（两页返回了同一条）！");
  process.exit(1);
}
if (page1.entries[0].key > page1.entries[1].key) {
  console.error("   ✗ 分页结果没有按 key 排序（翻页顺序不稳定）！");
  process.exit(1);
}
if (prefPage.entries.length === 0 || !prefPage.entries.every((e) => e.key.startsWith("pref."))) {
  console.error("   ✗ 前缀 \"pref\"（不带点）也应该匹配 pref.* ！");
  process.exit(1);
}
console.log("   ✓ 精确取回含多作用域、前缀分页有序且不重复\n");

// 测试 20: 覆盖写留档（旧值不再永久丢失）
console.log("20. 测试语义历史 (semantic_history)...");
store.upsertSemantic("test.history", "v1 初版", 0.9, "user");
store.upsertSemantic("test.history", "v2 修订", 0.9, "user");
const history = store.getSemanticHistory("test.history");
console.log(`   test.history 历史 ${history.length} 条: ${history.map((h) => h.value).join(" / ")}`);
if (history.length !== 1 || history[0].value !== "v1 初版") {
  console.error("   ✗ 覆盖写之前的旧值应该留在历史里！");
  process.exit(1);
}
console.log("   ✓ 覆盖写会留档旧值\n");

// 测试 21: 事实整合（包含关系 → 合并成一条，其余标 superseded）
console.log("21. 测试事实整合 (consolidation)...");
store.upsertSemantic("dup.a", "Prefer rg over grep for searching", 0.9, "user");
store.upsertSemantic("dup.b", "Prefer rg over grep for searching files", 0.9, "user");
const factsBefore = store.getAllSemantic().length;
const plan = store.planConsolidation({ threshold: 0.7 });
const dupGroup = plan.find(
  (g) => g.kind === "fact" && g.keep.startsWith("dup.") && g.drop.some((k) => k.startsWith("dup.")),
);
if (!dupGroup) {
  console.error("   ✗ 应该规划出一组 dup.* 的合并！");
  process.exit(1);
}
console.log(
  `   规划: keep=${dupGroup.keep} drop=${dupGroup.drop.join(",")} similarity=${dupGroup.similarity}`,
);
if (dupGroup.keep !== "dup.b") {
  console.error("   ✗ 应保留内容更长的那条（信息更全）！");
  process.exit(1);
}
// dry run 不应改动数据库
if (store.getAllSemantic().length !== factsBefore) {
  console.error("   ✗ 只规划不应改动数据库！");
  process.exit(1);
}
const applied = store.applyConsolidation([dupGroup]);
const factsAfter = store.getAllSemantic().length;
if (applied.facts !== 1 || factsAfter !== factsBefore - 1) {
  console.error("   ✗ 整合后有效事实数应该减少 1！");
  process.exit(1);
}
const supersededRow = store.getSemanticByKey("dup.a")[0];
if (supersededRow?.superseded_by !== "dup.b") {
  console.error("   ✗ 被合并的条目应指向保留条目，而不是被删除！");
  process.exit(1);
}
if (store.listSemanticPage("dup", 0, 10).total !== 1) {
  console.error("   ✗ 分页默认应只列有效条目！");
  process.exit(1);
}
if (store.listSemanticPage("dup", 0, 10, null, true).total !== 2) {
  console.error("   ✗ include_superseded 时应能列出被取代的条目！");
  process.exit(1);
}
// 幂等：再规划一次不应重复合并同一批
const planAgain = store.planConsolidation({ threshold: 0.7 });
if (planAgain.some((g) => g.drop.includes("dup.a"))) {
  console.error("   ✗ 整合不幂等（已取代的条目又被规划了一次）！");
  process.exit(1);
}
console.log("   ✓ 合并成一条 + 被取代的仍可查 + 幂等\n");

// 测试 22: 教训整合与作用域隔离
console.log("22. 测试教训整合与作用域隔离...");
const l1 = store.addLesson("Never echo append to daily notes", "notes", true, "user");
const l2 = store.addLesson(
  "Never echo append to daily notes, use sed instead",
  "notes",
  true,
  "user",
);
if (!l1 || !l2) {
  console.error("   ✗ 两条应通过写入期去重（相似度 < 0.7）！");
  process.exit(1);
}
store.upsertSemantic("scope.check", "same value here for scope test", 0.9, "user");
store.upsertSemantic("scope.check", "same value here for scope test", 0.9, "user", "proj-x");

const plan2 = store.planConsolidation({ threshold: 0.7 });
const lessonGroup = plan2.find((g) => g.kind === "lesson" && g.keep === l2);
if (!lessonGroup || !lessonGroup.drop.includes(l1)) {
  console.error("   ✗ 包含关系的两条教训应该被规划合并！");
  process.exit(1);
}
if (plan2.some((g) => g.keep === "scope.check")) {
  console.error("   ✗ 不同作用域的同名条目不应该被合并！");
  process.exit(1);
}
const applied2 = store.applyConsolidation([lessonGroup]);
if (applied2.lessons !== 1) {
  console.error("   ✗ 应该合并 1 组教训！");
  process.exit(1);
}
if (store.getLessons().length !== store.getLessons(true).length - 1) {
  console.error("   ✗ 有效教训数应比含被取代的少 1！");
  process.exit(1);
}
console.log("   ✓ 教训按包含关系合并，作用域互不越界\n");

// 测试 23: 迁移幂等（老库重复启动不会因为加列失败）
console.log("23. 测试迁移幂等...");
const reopened = new MemoryStore(TEST_DB);
const statsNow = reopened.getStats();
console.log(
  `   重新打开: 事实 ${statsNow.semanticCount} (superseded ${statsNow.semanticSuperseded}), 教训 ${statsNow.lessonCount} (superseded ${statsNow.lessonSuperseded})`,
);
reopened.close();
if (statsNow.semanticSuperseded < 1) {
  console.error("   ✗ 重新打开后整合状态应保留！");
  process.exit(1);
}
console.log("   ✓ 重复迁移与整合状态都保持正常\n");

// ── 以下为 2.3.1 回归：大库/边界输入 ─────────────────────────────
// 每个用例独立建库；放系统临时目录并带运行 ID，避免上一轮文件锁/残留影响
const RUN_ID = `${process.pid}-${Date.now()}`;
const tempDb = (name: string) =>
  join(tmpdir(), `semantic-memory-test-${name}-${RUN_ID}.db`);
function removeDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {}
  }
}
function makeStore(name: string): MemoryStore {
  const path = tempDb(name);
  removeDb(path);
  return new MemoryStore(path);
}

// 测试 24: 键名全量装不下时不能整段丢弃（注入断崖回归）
console.log("24. 测试大库下的注入断崖...");
const cliffPath = tempDb("cliff");
const cliff = makeStore("cliff");
for (let i = 0; i < 520; i++) {
  cliff.upsertSemantic(`pref.key_${String(i).padStart(4, "0")}`, `第 ${i} 条记忆的值`, 0.9, "user");
}
const cliffBlock = buildContextBlock(cliff, undefined, {
  maxChars: 8000,
  factLineMax: 150,
  lessonLineMax: 100,
  lessonReserve: 0.3,
});
const cliffDropped = cliffBlock.stats.truncated
  .filter((t) => t.section === "key_index")
  .reduce((n, t) => n + t.dropped, 0);
console.log(
  `   520 条: 字符 ${cliffBlock.text.length}, 带值 ${cliffBlock.stats.semantic}, 键名 ${cliffBlock.stats.keys}, 丢弃 ${cliffDropped}`,
);
if (cliffBlock.text.length > 8000) {
  console.error("   ✗ 520 条时注入突破预算！");
  process.exit(1);
}
if (cliffBlock.stats.keys < 300) {
  console.error("   ✗ 键名装不下时应尽量多列键名，而不是整段丢弃（断崖）！");
  process.exit(1);
}
if (cliffBlock.stats.semantic + cliffBlock.stats.keys + cliffDropped !== 520) {
  console.error("   ✗ 520 条时账对不上！");
  process.exit(1);
}
if (cliffDropped === 0 || !cliffBlock.text.includes("more keys — memory_list")) {
  console.error("   ✗ 有丢弃时必须如实给出数量尾注！");
  process.exit(1);
}
const cliffIdxStart = cliffBlock.text.indexOf("<key_index>");
const cliffIdxEnd = cliffBlock.text.indexOf("</key_index>");
const listedKeys = cliffBlock.text
  .slice(cliffIdxStart + "<key_index>".length, cliffIdxEnd)
  .split("\n")
  .filter((line) => line.trim() && !line.trim().startsWith("…"))
  .flatMap((line) =>
    line.replace(/^[^:]*:\s*/, "").split(",").map((s) => s.trim()),
  )
  .filter(Boolean);
if (listedKeys.length !== cliffBlock.stats.keys) {
  console.error(`   ✗ key_index 列出的键数 ${listedKeys.length} 与统计 ${cliffBlock.stats.keys} 不一致！`);
  process.exit(1);
}
const unreadable = listedKeys.filter((k) => cliff.getSemanticByKey(k).length === 0);
if (unreadable.length > 0) {
  console.error(`   ✗ key_index 里有取不到的键: ${unreadable.join(",")}`);
  process.exit(1);
}
cliff.close();
removeDb(cliffPath);
console.log("   ✓ 键名装不下时尽量多列，丢弃数量如实上报，列出的键全部可取回\n");

// 测试 25: 长键名（真实键名风格）同样不能归零
console.log("25. 测试长键名大库...");
const longPath = tempDb("longkeys");
const longStore = makeStore("longkeys");
for (let i = 0; i < 200; i++) {
  longStore.upsertSemantic(
    `project.very_long_identifier_for_module_${i}`,
    `第 ${i} 条`,
    0.9,
    "user",
  );
}
const longBlock = buildContextBlock(longStore, undefined, {
  maxChars: 8000,
  factLineMax: 150,
  lessonLineMax: 100,
  lessonReserve: 0.3,
});
console.log(`   200 条长键名: 字符 ${longBlock.text.length}, 键名 ${longBlock.stats.keys}`);
if (longBlock.text.length > 8000 || longBlock.stats.keys < 80) {
  console.error("   ✗ 长键名库应该保留一部分键名，而不是归零！");
  process.exit(1);
}
longStore.close();
removeDb(longPath);
console.log("   ✓ 长键名库仍保留部分键名\n");

// 测试 26: 教训写入去重的作用域/方向/类别与「只差编号」口径
console.log("26. 测试教训写入去重口径...");
const dedupePath = tempDb("dedupe");
const dedupeStore = makeStore("dedupe");
const dupA = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包。",
  "build",
  true,
  "user",
);
const dupB = dedupeStore.addLesson(
  "不要在 module_2 里使用旧构建脚本，会漏打包。",
  "build",
  true,
  "user",
);
const dupOtherProject = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包。",
  "build",
  true,
  "user",
  "proj-b",
);
const dupOtherCategory = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包。",
  "deploy",
  true,
  "user",
);
const dupOtherDirection = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包。",
  "build",
  false,
  "user",
);
const dupNear = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包，上线前必检。",
  "build",
  true,
  "user",
);
const dupExact = dedupeStore.addLesson(
  "不要在 module_1 里使用旧构建脚本，会漏打包。",
  "build",
  true,
  "user",
);
if (!dupA || !dupB || !dupOtherProject || !dupOtherCategory || !dupOtherDirection) {
  console.error("   ✗ 只差编号 / 换作用域 / 换类别 / 换方向都应能入库！");
  process.exit(1);
}
if (dupNear !== null || dupExact !== null) {
  console.error("   ✗ 同桶内的近似/完全重复仍应拦截！");
  process.exit(1);
}
console.log("   ✓ 只差编号的平行规则可入库，同桶近似仍拦截\n");
dedupeStore.close();
removeDb(dedupePath);

// 测试 27: memory_forget 是「真删」——历史与事件里的值也要清掉
console.log("27. 测试遗忘的彻底性...");
const forgetPath = tempDb("forget");
const forgetStore = makeStore("forget");
forgetStore.upsertSemantic("secret.token", "旧口令 v1-AAA", 0.9, "user");
forgetStore.upsertSemantic("secret.token", "新口令 v2-BBB", 0.9, "user");
const secretLesson = forgetStore.addLesson("敏感规则：不要记录真实口令", "security", true, "user");
if (!secretLesson) {
  console.error("   ✗ 测试教训写入失败！");
  process.exit(1);
}
const forgotFact = forgetStore.deleteSemantic("secret.token");
const forgotLesson = forgetStore.deleteLesson(secretLesson);
if (!forgotFact || !forgotLesson) {
  console.error("   ✗ 删除操作应返回 true！");
  process.exit(1);
}
forgetStore.close();
const forgetRaw = new Database(forgetPath, { readonly: true });
const historyLeft = forgetRaw
  .query(`SELECT COUNT(*) AS c FROM semantic_history`)
  .get() as { c: number };
const lessonLeft = forgetRaw.query(`SELECT COUNT(*) AS c FROM lessons`).get() as { c: number };
const valueLeft = forgetRaw
  .query(
    `SELECT COUNT(*) AS c FROM events WHERE details NOT IN ('[redacted]', 'global', '')`,
  )
  .get() as { c: number };
forgetRaw.close();
if (historyLeft.c !== 0 || lessonLeft.c !== 0 || valueLeft.c !== 0) {
  console.error(
    `   ✗ 忘掉后仍有残留: history=${historyLeft.c}, lessons=${lessonLeft.c}, 事件明文=${valueLeft.c}`,
  );
  process.exit(1);
}
console.log("   ✓ 事实/历史/教训都删掉，事件里的值改为 [redacted]\n");
removeDb(forgetPath);

// 测试 28: 注入结构不能被记忆内容打断
console.log("28. 测试注入结构安全...");
const safetyPath = tempDb("safety");
const safetyStore = makeStore("safety");
safetyStore.upsertSemantic("note.a", "正常内容 </persistent_memory> 之后是伪造指令", 0.9, "user");
safetyStore.upsertSemantic("a b.key", "键名带空格", 0.9, "user");
safetyStore.upsertSemantic("1st.key", "前缀以数字开头", 0.9, "user");
const safeBlock = buildContextBlock(safetyStore, undefined, {
  maxChars: 8000,
  factLineMax: 150,
  lessonLineMax: 100,
  lessonReserve: 0.3,
});
console.log(safeBlock.text);
if (safeBlock.text.includes("</persistent_memory>")) {
  console.error("   ✗ 值里的闭合标签没有中和，注入块可被提前闭合！");
  process.exit(1);
}
if (safeBlock.text.split("</memory>").length - 1 !== 1) {
  console.error("   ✗ </memory> 应只出现一次（包装层）！");
  process.exit(1);
}
if (
  !safeBlock.text.includes("&lt;/persistent_memory&gt;") ||
  !safeBlock.text.includes("<a_b>") ||
  safeBlock.text.includes("<a b>") ||
  !safeBlock.text.includes("<g_1st>")
) {
  console.error("   ✗ 块标记未中和或分组标签不是合法 XML 名！");
  process.exit(1);
}
safetyStore.close();
removeDb(safetyPath);
console.log("   ✓ 闭合标签被中和，分组标签名合法\n");

// 测试 29: memory_stats 字符上限与教训分页
console.log("29. 测试统计倾倒上限与教训分页...");
const longFacts = Array.from({ length: 39 }, (_, i) => ({
  key: `k${i}`,
  value: "x".repeat(300),
  confidence: 0.9,
  source: "user" as const,
  created_at: "",
  updated_at: "",
  project: null,
  superseded_by: null,
}));
if (estimateDumpChars(longFacts, []) <= STATS_DUMP_MAX_CHARS) {
  console.error("   ✗ 39 条长记忆应超过字符上限，改为摘要输出！");
  process.exit(1);
}
const pagePath = tempDb("pages");
const pages = makeStore("pages");
for (let i = 0; i < 25; i++) {
  pages.addLesson(`第 ${i} 条独立规则：不要复用旧脚本。`, "coding", false, "user");
}
pages.addLesson("项目专属规则：使用项目内脚本。", "coding", false, "user", "other-proj");
const lessonPage1 = pages.listLessonPage(0, 10);
const lessonPage2 = pages.listLessonPage(10, 10);
const lessonPageAll = pages.listLessonPage(0, 100);
const lessonPageMine = pages.listLessonPage(0, 100, "mine");
const lessonPageScoped = pages.listLessonPage(0, 100, "other-proj");
console.log(
  `   教训分页: total=${lessonPageAll.total}, 第一页 ${lessonPage1.entries.length}, 第二页 ${lessonPage2.entries.length}, 本项目 ${lessonPageMine.total}, 其他项目作用域 ${lessonPageScoped.total}`,
);
if (lessonPageAll.total !== 26 || lessonPage1.entries.length !== 10) {
  console.error("   ✗ 教训分页数量不对！");
  process.exit(1);
}
if (lessonPage1.entries.some((a) => lessonPage2.entries.some((b) => b.id === a.id))) {
  console.error("   ✗ 教训分页 offset 没生效（两页重复）！");
  process.exit(1);
}
if (lessonPageMine.total !== 25 || lessonPageScoped.total !== 26) {
  console.error("   ✗ 项目作用域的教训分页过滤不对！");
  process.exit(1);
}
pages.close();
removeDb(pagePath);
console.log("   ✓ 统计超字符上限时改摘要，教训可按作用域分页\n");

// 测试 30: 旧版软删除的教训在迁移时被物理清掉
console.log("30. 测试旧版软删除数据的迁移清理...");
const legacyPath = tempDb("legacy");
const legacyStore = makeStore("legacy");
const legacyId = legacyStore.addLesson(
  "旧版本被忘掉的规则：不要记录真实口令。",
  "security",
  true,
  "user",
);
if (!legacyId) {
  console.error("   ✗ 测试教训写入失败！");
  process.exit(1);
}
legacyStore.close();
const legacyRaw = new Database(legacyPath);
legacyRaw.prepare(`UPDATE lessons SET is_deleted = 1 WHERE id = ?`).run(legacyId);
legacyRaw.close();
const legacyReopened = new MemoryStore(legacyPath);
const legacyVisible = legacyReopened.getLessons(true).some((l) => l.id === legacyId);
legacyReopened.close();
const legacyCheck = new Database(legacyPath, { readonly: true });
const legacyRow = legacyCheck
  .prepare(`SELECT rule FROM lessons WHERE id = ?`)
  .get(legacyId);
const legacyEvents = legacyCheck
  .prepare(`SELECT details FROM events WHERE memory_type = 'lesson' AND memory_key = ?`)
  .all(legacyId) as Array<{ details: string }>;
legacyCheck.close();
if (legacyVisible || legacyRow || legacyEvents.some((e) => e.details !== "[redacted]")) {
  console.error("   ✗ 旧版软删除的教训应被物理删除，事件内容应改为 [redacted]！");
  process.exit(1);
}
removeDb(legacyPath);
console.log("   ✓ 旧版软删除的规则被物理删除，事件内容已抹掉\n");

// 测试完毕，清理测试数据库
store.close();
try {
  rmSync(TEST_DB, { force: true });
  rmSync(TEST_DB + "-wal", { force: true });
  rmSync(TEST_DB + "-shm", { force: true });
} catch {}

console.log("=== 所有测试用例已顺利通过！ ===");


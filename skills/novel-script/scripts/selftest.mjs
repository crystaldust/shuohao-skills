#!/usr/bin/env node
// novel-script 自测：不调模型、不花额度，只验确定性逻辑。
// 原则与仓库里其他 skill 一致：每道质量门都要有击穿用例——
// 证明它真的会拦，不是一个永远为真的假测试。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isId, seededRng } from './ids.mjs';
import {
  DEFAULT_PARAMS,
  assignScriptIds,
  migrateScript,
  renumberScript,
  computeStats,
  gateReport,
  lineChars,
  paramsOf,
  renderHtml,
  renderMarkdown,
  sceneSeconds,
  seedFromOutline,
  slug,
  validateScript,
} from './novel-script.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, '../examples/渡口-script.json'), 'utf8'));
const OUTLINE = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-outline.json'), 'utf8'));
const ART = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-art.json'), 'utf8'));
const CAST = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-cast.json'), 'utf8'));
const CTX = { outline: OUTLINE, art: ART };

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}
function eq(actual, expected, label) {
  assert.equal(actual, expected, `${label} — 期望 ${expected}，实际 ${actual}`);
  passed += 1;
}
const clone = (x) => structuredClone(x);
const gate = (doc, id, ctx = {}) => gateReport(doc, ctx).find((g) => g.id === id);

/* ---------------- 时长引擎 ---------------- */

eq(lineChars('你好，世界。'), 6, '标点算时间——停顿也是时间');
eq(lineChars('  你 好  '), 2, '空白不算字符');
eq(lineChars(''), 0, '空串为零');
eq(lineChars(null), 0, 'null 不崩');

const sc = {
  flow: [
    { action: '雾漫上来。' },
    { speaker: 'C01', line: '一二三四五六七八九' }, // 9 字 → 2 秒
    { action: '船离岸。' },
  ],
};
const sec = sceneSeconds(sc);
eq(sec.action, 5, '两个动作节拍 × 2.5 秒');
eq(sec.dialogue, 2, '9 字 ÷ 4.5 字每秒 = 2 秒');
eq(sec.total, 7, '总时长 = 台词 + 动作');
eq(sceneSeconds({ flow: [] }).total, 0, '空节拍流为零秒');

eq(paramsOf({}).charsPerSecond, DEFAULT_PARAMS.charsPerSecond, '默认参数生效');
eq(paramsOf({ params: { charsPerSecond: 6 } }).charsPerSecond, 6, 'params 可覆盖语速');
eq(paramsOf({ params: { charsPerSecond: 6 } }).tolerance, DEFAULT_PARAMS.tolerance, '只覆盖给出的键');
eq(sceneSeconds(sc, { ...DEFAULT_PARAMS, charsPerSecond: 9 }).dialogue, 1, '语速参数参与计算');

/* ---------------- computeStats ---------------- */

const stats = computeStats(FIXTURE);
eq(stats.totals.episodes, 6, '样例全六集');
eq(stats.totals.scenes, 9, '样例九场');
eq(stats.totals.lines, 143, '样例台词句数');
ok(stats.totals.estSeconds > 600 && stats.totals.estSeconds < 750, '预估总时长在目标带附近');
eq(stats.totals.targetSeconds, 720, '目标秒数汇总');
ok(stats.episodes.every((e) => e.est >= 102 && e.est <= 138), '每一集都落在 ±15% 容差带内');
ok(stats.episodes[0].dialogueSeconds > 0 && stats.episodes[0].actionSeconds > 0, '台词与动作分开计秒');
eq(stats.sceneTable.length, 9, '场次总表九行');
eq(stats.sceneTable[0].sceneId, 'S02', '场次总表按出场顺序');
ok(stats.sceneTable[0].lineCount > 0, '场次表带台词句数');
eq(stats.castLines.length, 6, '台词本六个说话人（含画外音，含第 6 集才开口的更夫）');
ok(stats.castLines[0].count >= stats.castLines[stats.castLines.length - 1].count, '台词本按句数降序');
const voEntry = stats.castLines.find((c) => c.id === 'VO');
ok(voEntry, '画外音单独成组');
eq(voEntry.lines[0].ep, 1, '台词条目带集号');
ok(voEntry.lines[0].sceneId === 'S01', '台词条目带场景');

/* ---------------- 质量门：全绿基线 ---------------- */

ok(gateReport(FIXTURE, CTX).every((g) => g.ok), '样例带上游全部门通过');
ok(gateReport(FIXTURE).every((g) => g.ok), '不带上游也全部通过（对账门跳过）');
eq(gateReport(FIXTURE).length, 11, '十一道门');

/* ---------------- 质量门：逐门击穿 ---------------- */

// duration — 写超
{
  const doc = clone(FIXTURE);
  for (let i = 0; i < 30; i++) doc.episodes[0].scenes[0].flow.push({ action: `加戏第 ${i} 拍。` });
  const g = gate(doc, 'duration');
  ok(!g.ok, '写超时长被拦');
  ok(g.detail.includes('超'), '超时报得出秒数');
}
// duration — 写欠
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes = [doc.episodes[0].scenes[0]];
  const g = gate(doc, 'duration');
  ok(!g.ok, '写欠时长被拦');
  ok(g.detail.includes('欠'), '欠时报得出秒数');
}
// duration — 容差可配
{
  const doc = clone(FIXTURE);
  doc.params = { tolerance: 0.01 };
  ok(!gate(doc, 'duration').ok, '容差收紧到 1% 后原样例不再达标');
}
// line-length
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ speaker: 'C03', line: '这句台词故意写得非常非常长，长到一口气根本读不完，纯粹为了击穿单句上限这道门而存在。' });
  const g = gate(doc, 'line-length');
  ok(!g.ok, '超长台词被拦');
  ok(g.detail.includes('字'), '报出字数');
}
// line-length — 上限跟分镜一切的最长秒数对齐：一拍只能落进一切，装不进的台词分镜怎么修都过不了
{
  eq(DEFAULT_PARAMS.maxLineChars, 22, '默认单句上限 = 5 秒 × 4.5 字/秒取整');
  const doc = clone(FIXTURE);
  const flow = doc.episodes[0].scenes[0].flow;
  flow.push({ speaker: 'C03', line: '三个月可以。章程上请写一句：验过的样，谁也不许动。' });
  ok(!gate(doc, 'line-length').ok, '25 字（5.6 秒）的台词在剧本层就被拦下');
  flow[flow.length - 1] = { speaker: 'C03', line: '一二三四五六七八九十一二三四五六七八九十一二' };
  ok(gate(doc, 'line-length').ok, '22 字正好放行');
}
{
  eq(paramsOf({ params: { charsPerSecond: 6 } }).maxLineChars, 30, '语速调快，单句上限跟着按 5 秒折算');
  eq(paramsOf({ params: { charsPerSecond: 6, maxLineChars: 12 } }).maxLineChars, 12, '显式给了 maxLineChars 就用给的');
}
// speaker
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ speaker: 'C99', line: '我不在这场里。' });
  ok(!gate(doc, 'speaker').ok, '不在本场的说话人被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ speaker: 'VO', line: '画外音不受本场人物限制。' });
  ok(gate(doc, 'speaker').ok, 'VO 合法');
}
// hook-cliff
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hook = ' ';
  ok(!gate(doc, 'hook-cliff').ok, '空钩子被拦');
}
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].cliff;
  ok(!gate(doc, 'hook-cliff').ok, '缺结尾悬念被拦');
}
// hook-open — 钩子必须在全集前 3 拍内兑现（认领机制）
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].hookBeat;
  const g = gate(doc, 'hook-open');
  ok(!g.ok, '缺 hookBeat 被拦');
  ok(g.detail.includes('hookBeat'), '报出缺的字段');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = doc.episodes[0].scenes[1].flow[0].id; // 第 2 场第 1 拍 = 全集第 14 拍
  const g = gate(doc, 'hook-open');
  ok(!g.ok, '钩子落在第 14 拍被拦——冷开场是门不是建议');
  ok(g.detail.includes('第 14 拍'), '报出实际位置');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = 'bt_zzzzzzzz';
  ok(gate(doc, 'hook-open').detail.includes('不在这一集里'), '指向不存在的节拍被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = doc.episodes[1].scenes[0].flow[0].id;
  ok(gate(doc, 'hook-open').detail.includes('不在这一集里'), '指向别的集的节拍也被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = [1, 1];
  const g = gate(doc, 'hook-open');
  ok(!g.ok && g.detail.includes('3.0 起写节拍 id'), '2.x 的 [场, 拍] 写法被拦，并提示改写节拍 id');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].hookBeat = doc.episodes[0].scenes[1].flow[0].id;
  doc.params = { hookWindow: 20 };
  ok(gate(doc, 'hook-open').ok, '钩子窗口可按需放宽');
}
// has-action
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow = doc.episodes[0].scenes[0].flow.filter((b) => typeof b.line === 'string');
  const g = gate(doc, 'has-action');
  ok(!g.ok, '纯对白的场（广播剧）被拦');
  ok(g.detail.includes('S02'), '点名到场');
}
// action-prose
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ action: '老周说「坐稳了」，随即撑篙。' });
  ok(!gate(doc, 'action-prose').ok, '动作里混台词引号被拦');
}
// beats-claimed
{
  const doc = clone(FIXTURE);
  doc.episodes[0].beatsClaimed = [];
  ok(!gate(doc, 'beats-claimed', CTX).ok, '大纲爽点没认领被拦');
  ok(gate(doc, 'beats-claimed').ok, '没给大纲时本门跳过');
  ok(gate(doc, 'beats-claimed').detail.includes('跳过'), '跳过要明说，不静默');
}
// refs-characters
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].characters.push('C99');
  ok(!gate(doc, 'refs-characters', CTX).ok, '大纲里没有的角色被拦');
  ok(gate(doc, 'refs-characters').ok, '没给大纲时本门跳过');
}
// refs-scenes：场景 / 光照 / 道具三个方向都要拦
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].sceneId = 'S99';
  ok(!gate(doc, 'refs-scenes', CTX).ok, '不存在的场景被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].lighting = '正午烈日';
  const g = gate(doc, 'refs-scenes', CTX);
  ok(!g.ok, '没登记过的光照状态被拦');
  ok(g.detail.includes('正午烈日'), '光照违规点得出名');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].props.push('P99');
  ok(!gate(doc, 'refs-scenes', CTX).ok, '不存在的道具被拦');
  ok(gate(doc, 'refs-scenes').ok, '没给美术设定时本门跳过');
}

/* ---------------- validateScript 结构检查 ---------------- */

eq(validateScript(FIXTURE, CTX).length, 0, '样例零违规');
ok(validateScript(null).length > 0, 'null 不崩');
ok(validateScript({}).some((p) => p.includes('source')), '缺 source 报出来');
ok(validateScript({ source: 'x', episodes: [] }).some((p) => p.includes('episodes')), '空 episodes 报出来');
{
  const doc = clone(FIXTURE);
  doc.episodes.push(clone(doc.episodes[0]));
  ok(validateScript(doc).some((p) => p.includes('重复')), '重复集号报出来');
}
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].targetSeconds;
  ok(validateScript(doc).some((p) => p.includes('targetSeconds')), '缺目标秒数报出来');
}
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].beatsClaimed;
  ok(validateScript(doc).some((p) => p.includes('beatsClaimed')), '缺爽点认领字段报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].sceneId = '船舱';
  ok(validateScript(doc).some((p) => p.includes('S01 这种格式')), 'sceneId 格式报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow = [];
  ok(validateScript(doc).some((p) => p.includes('节拍流为空')), '空节拍流报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ action: '动作', line: '台词', speaker: 'C01' });
  ok(validateScript(doc).some((p) => p.includes('二选一')), '节拍不许既是动作又是台词');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ delivery: '只有语气' });
  ok(validateScript(doc).some((p) => p.includes('二选一')), '两头都不是也拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ speaker: 'C03', line: '   ' });
  ok(validateScript(doc).some((p) => p.includes('空台词')), '空台词报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ line: '没有说话人。' });
  ok(validateScript(doc).some((p) => p.includes('speaker')), '台词缺说话人报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].scenes[0].flow.push({ action: '  ' });
  ok(validateScript(doc).some((p) => p.includes('空动作')), '空动作节拍报出来');
}
ok(validateScript(clone(FIXTURE)).length === 0, '不带上游校验也通过');

/* ---------------- seed ---------------- */

const seeded = seedFromOutline(OUTLINE);
eq(seeded.source, '渡口', 'seed 带书名');
eq(seeded.episodes[0].id, OUTLINE.episodes[0].id, 'seed 照抄大纲的集 id');
eq(Object.keys(seeded.episodes[0])[0], 'id', '集 id 排在第一个键');
{
  const noIds = clone(OUTLINE);
  delete noIds.episodes[0].id;
  let msg = '';
  try { seedFromOutline(noIds); } catch (e) { msg = e.message; }
  ok(msg.includes('ids --write'), '大纲缺集 id 时 seed 拒绝，并提示先补 id');
}
eq(seeded.episodes.length, 6, 'seed 全六集');
eq(seeded.episodes[0].targetSeconds, 120, '目标秒数 = 每集分钟 × 60');
eq(seeded.episodes[0].hook, OUTLINE.episodes[0].hook, '钩子从大纲搬');
eq(seeded.episodes[0].cliff, OUTLINE.episodes[0].suspense, '悬念从大纲搬');
eq(seeded.episodes[0].beatsClaimed.join(','), '悬念钩', '第 1 集预填悬念钩');
eq(seeded.episodes[2].beatsClaimed.join(','), '身份揭破', '第 3 集预填身份揭破');
eq(seeded.episodes[1].beatsClaimed.length, 0, '没有爽点的集为空数组');
eq(seeded.episodes[0].scenes.length, 0, 'scenes 留空给模型写戏');
ok(seeded.episodes[0].seedNote.includes('S01'), 'seedNote 带候选场景');
ok(seeded.episodes[0].seedNote.includes(OUTLINE.episodes[0].synopsis.slice(0, 10)), 'seedNote 带梗概');
eq(seedFromOutline(OUTLINE, [3, 5]).episodes.map((e) => e.ep).join(','), '3,4,5', '--eps 区间过滤');
eq(seedFromOutline(OUTLINE, [2, 2]).episodes.length, 1, '单集区间');
eq(seedFromOutline({}).episodes.length, 0, '空大纲不崩');
eq(seedFromOutline({ params: {} }).episodes.length, 0, '缺分钟数用默认值不崩');

/* ---------------- slug ---------------- */

eq(slug('渡口'), '渡口', '中文原样');
eq(slug('a b/c'), 'a-b-c', '空格斜杠转短横');
eq(slug('  '), 'script', '空名兜底');

/* ---------------- render markdown ---------------- */

const md = renderMarkdown(FIXTURE, CTX);
ok(md.includes('# 渡口 · 剧本（第 1–6 集）'), 'md 标题带集数区间');
ok(md.includes('第 1 场 · 渡口栈桥（浓雾清晨）'), 'md 场头显示场景名与光照');
ok(md.includes('**老周**'), 'md 说话人显示名字不是 ID');
ok(md.includes('**画外音**'), 'md 里 VO 显示成画外音');
ok(md.includes('场次总表'), 'md 带场次总表');
ok(md.includes('台词本'), 'md 带台词本');
ok(md.includes('第 1 场第 1 拍兑现'), 'md 钩子行带认领位置');
const mdBare = renderMarkdown(FIXTURE);
ok(mdBare.includes('**C03**'), '不给上游时退回裸 ID');
ok(mdBare.includes('S02'), '场景同样退回 ID');

/* ---------------- render html ---------------- */

const html = renderHtml(FIXTURE, CTX);
ok(html.includes('<!doctype html>'), 'html 完整文档');
ok(!/src="http|href="http|@import|url\(http/.test(html), '零外部资源');
ok(html.includes('时长仪表'), '01 时长仪表');
ok(html.includes('分集剧本'), '02 分集剧本');
ok(html.includes('场次总表'), '03 场次总表');
ok(html.includes('台词本'), '04 台词本');
ok(html.includes('质量门'), '05 质量门');
ok(html.includes('✓ 质量门 11 / 11'), '页眉徽章全绿');
ok(html.includes('class="band"'), '时长条带目标区间');
ok(html.includes('导出 JSON'), '导出按钮在');
ok(html.includes('id="script-data"'), '数据内嵌');
ok(html.includes('渡口-script.json'), '导出文件名');
ok(html.includes('data-copy'), '复制按钮在');
ok(html.includes('复制全部台词'), '台词本整组复制');
ok(html.includes('@media print'), '打印样式在');
ok(html.includes('prefers-reduced-motion'), '动效可关');
ok(html.includes('class="eps"'), '分集剧本一排两集网格');
ok(html.includes('class="scenes clip"'), '场次区默认最多 300px 截断');
ok(html.includes('展开全部场次'), '每集自带展开与收起按钮');
ok(html.includes('class="casts"'), '台词本一排两个网格');
ok(html.includes('max-height:186px'), '台词列表六行高，纵向滚动');
{
  const solo = renderHtml({ source: '渡口', episodes: [clone(FIXTURE.episodes[0])] }, CTX);
  ok(solo.includes('eps solo'), '单集单列，不留空半栏');
  ok(solo.includes('剧本（第 1 集）'), '单集标题不带区间');
}
ok(html.includes('老周'), 'html 里 ID 换成名字');
ok(html.includes('晨雾'), '光照 chips 在');
ok(html.includes('第 1 场第 1 拍兑现'), '钩子行带认领徽章');
ok(html.includes('act-line hooked'), '认领的节拍在正文里高亮');
ok(!html.includes('音色提示词'), '不给 --cast 就没有音色按钮——不猜');
{
  const withCast = renderHtml(FIXTURE, { ...CTX, cast: CAST });
  ok(withCast.includes('音色提示词'), '给了 --cast 台词本带音色提示词按钮');
  // 从 cast 里取，别硬编样例内容——样例的音色提示词改过形态，
  // 写死字符串的断言会跟着挂，而且它验的本来就不是「内容长什么样」
  const anyPrompt = CAST.characters.find((c) => c?.voice?.prompt)?.voice?.prompt ?? '';
  ok(anyPrompt.length > 0, '样例 cast 里有音色提示词');
  // html 里字符是转义过的，取一段不含特殊字符的片段来比对
  const frag = anyPrompt.split(',')[0].trim();
  ok(frag.length > 5 && withCast.includes(frag), '音色提示词是 cast 的 voice.prompt 原文');
}
ok(html.includes('lang="zh"'), '默认报告 html lang 是 zh');

/* ---------------- render — 英文界面 ---------------- */

{
  const en = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(en.includes('lang="en"'), 'en 报告的 html lang 属性正确');
  ok(en.includes('Export JSON'), 'en 导出按钮标签');
  ok(en.includes('Quality gates 11 / 11'), 'en 页眉徽章全绿');
  ok(en.includes('Line book'), 'en 台词本标题');
  ok(en.includes('Duration gauge'), 'en 时长仪表标题');
  ok(!en.includes('导出 JSON'), 'en 报告不含中文导出标签');
  ok(!en.includes('质量门'), 'en 报告不含中文质量门标签');
  ok(!en.includes('台词本'), 'en 报告不含中文台词本标签');
}
{
  const mdEn = renderMarkdown(FIXTURE, { ...CTX, lang: 'en' });
  ok(mdEn.includes('## Episode 1'), 'en md 分集标题是英文');
  ok(mdEn.includes('## Line book'), 'en md 台词本标题是英文');
}
{
  const doc = clone(FIXTURE);
  doc.lang = 'en';
  ok(renderMarkdown(doc, CTX).includes('## Episode 1'), 'script.json 顶层 lang 字段生效');
  ok(renderMarkdown(doc, { ...CTX, lang: 'zh' }).includes('## 第 1 集'), '--lang 优先于 JSON 的 lang 字段');
}
{
  let threw = false;
  try { renderHtml(FIXTURE, { ...CTX, lang: 'fr' }); } catch { threw = true; }
  ok(threw, '非内置语言直接抛错，不静默回退');
}

// 病灶横幅
{
  const doc = clone(FIXTURE);
  doc.episodes[1].hook = ''; // 击穿 hook-cliff 门
  const h = renderHtml(doc, CTX);
  ok(h.includes('class="galert"'), '有门未过时页顶挂病灶横幅');
  ok(h.includes('gatepill fail'), '徽章翻红');
}

// XSS：模型数据全部过 esc
{
  const doc = clone(FIXTURE);
  doc.source = '<script>alert(1)</script>';
  doc.episodes[0].scenes[0].flow.push({ speaker: 'C03', line: '<img src=x onerror=alert(1)>' });
  const h = renderHtml(doc);
  ok(!h.includes('<script>alert(1)</script>'), '标题被转义');
  ok(!h.includes('<img src=x'), '台词被转义');
  ok(h.includes('\\u003c'), '内嵌 JSON 的 < 转成 \\u003c，防 </script 截断');
}

// 质量门面板是报告的一部分：英文界面下门标签也要翻译（阈值由门自己算，原样保留）
{
  const gateEn = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(gateEn.includes('Episode duration within'), 'EN 报告的质量门标签翻译且阈值原样保留');
  ok(!gateEn.includes('每集时长在目标'), 'EN 报告不再出现中文门标签');
}

/* ---------------- 稳定 id ---------------- */
// 集 id 照抄大纲；场次、节拍由 ids 分配；hookBeat 指向节拍 id；显示用的集号由门对照大纲。

{
  ok(gate(FIXTURE, 'ids').ok && gate(FIXTURE, 'ids', CTX).ok, '样例的 id 门通过（带不带上游都过）');
  eq(gateReport(FIXTURE)[0].id, 'ids', 'id 门排第一道');
  const scenes = FIXTURE.episodes.flatMap((e) => e.scenes);
  ok(FIXTURE.episodes.every((e) => isId(e.id, 'ep')), '每集都有集 id');
  ok(scenes.every((s) => isId(s.id, 'sc')), '每场都有场次 id');
  ok(scenes.every((s) => s.flow.every((b) => isId(b.id, 'bt'))), '每拍都有节拍 id');
  ok(FIXTURE.episodes.every((e) => isId(e.hookBeat, 'bt')), 'hookBeat 都是节拍 id');
  ok(FIXTURE.episodes.every((e) => OUTLINE.episodes.some((o) => o.id === e.id && o.ep === e.ep)), '集 id 与集号都对得上大纲');
}
{
  const ids = (doc, ctx = {}) => gate(doc, 'ids', ctx);
  const a = clone(FIXTURE); delete a.episodes[0].scenes[1].id;
  ok(!ids(a).ok && ids(a).detail.includes('第 1 集第 2 场缺 id'), '缺场次 id 被拦并点名');
  const b = clone(FIXTURE); delete b.episodes[0].scenes[0].flow[2].id;
  ok(!ids(b).ok && ids(b).detail.includes('第 1 集第 1 场第 3 拍缺 id'), '缺节拍 id 被拦并点名');
  const c = clone(FIXTURE); c.episodes[0].scenes[0].id = 'S02';
  ok(!ids(c).ok && ids(c).detail.includes('格式不对'), '场次 id 格式错被拦');
  const d = clone(FIXTURE); d.episodes[1].scenes[0].flow[0].id = d.episodes[0].scenes[0].flow[0].id;
  ok(!ids(d).ok && ids(d).detail.includes('重复'), '节拍 id 跨集重复也被拦');
  const e = clone(FIXTURE); delete e.episodes[2].id;
  ok(!ids(e).ok && ids(e).detail.includes('第 3 集缺集 id'), '缺集 id 被拦');
  const f = clone(FIXTURE); f.episodes[0].id = 'ep_zzzzzzzz';
  ok(ids(f).ok, '不给大纲时不核对集 id 归属');
  ok(!ids(f, CTX).ok && ids(f, CTX).detail.includes('不在大纲里'), '给了大纲：集 id 不在大纲里被拦');
  const g = clone(FIXTURE); g.episodes[0].ep = 2;
  ok(!ids(g, CTX).ok && ids(g, CTX).detail.includes('大纲里是第 1 集'), '给了大纲：集号与大纲不一致被拦');
}
{
  // 爽点认领按 episodeRef 对上：把大纲的身份揭破挪到第 2 集，第 2 集就欠一个认领
  const outline = clone(OUTLINE);
  const b02 = outline.beats.find((b) => b.id === 'B02');
  b02.episodeRef = outline.episodes[1].id;
  b02.episode = 2;
  const g = gate(FIXTURE, 'beats-claimed', { outline, art: ART });
  ok(!g.ok && g.detail.includes('第 2 集缺「身份揭破」'), '爽点按集 id 归属对账');
}
{
  // 补 id：只补缺的，不改入参，可复现；集 id 只能从大纲来
  const raw = clone(FIXTURE);
  for (const ep of raw.episodes) {
    delete ep.id;
    for (const sc of ep.scenes) { delete sc.id; for (const bt of sc.flow) delete bt.id; }
  }
  raw.episodes[0].scenes[0].id = 'sc_00000001';
  const before = JSON.stringify(raw);
  const out = assignScriptIds(raw, { outline: OUTLINE, rng: seededRng('t') });
  eq(JSON.stringify(raw), before, 'assignScriptIds 不改入参');
  eq(out.episodes[0].scenes[0].id, 'sc_00000001', '已有场次 id 不动');
  ok(out.episodes.every((e, i) => e.id === OUTLINE.episodes[i].id), '集 id 按集号从大纲照抄');
  ok(out.episodes.flatMap((e) => e.scenes).every((s) => isId(s.id, 'sc') && s.flow.every((x) => isId(x.id, 'bt'))), '场次与节拍 id 都补上');
  eq(JSON.stringify(assignScriptIds(raw, { outline: OUTLINE, rng: seededRng('t') })), JSON.stringify(out), '同一种子可复现');
  ok(assignScriptIds(raw, { rng: seededRng('t') }).episodes.every((e) => e.id === undefined), '不给大纲就不补集 id——集 id 只能来自大纲');
}
{
  // 插一拍：只多一个新 id；hookBeat 跟着原来那一拍，全集位置后移
  const doc = clone(FIXTURE);
  const hb = doc.episodes[0].hookBeat;
  doc.episodes[0].scenes[0].flow.unshift({ action: '雾里传来一声船笛。' });
  const out = assignScriptIds(doc, { outline: OUTLINE, rng: seededRng('insert') });
  const before = new Set(JSON.stringify(FIXTURE).match(/"(sc|bt)_[0-9a-z]{8}"/g));
  const after = JSON.stringify(out).match(/"(sc|bt)_[0-9a-z]{8}"/g).filter((x) => !before.has(x));
  eq(after.length, 1, '插一拍只多出一个新 id');
  eq(out.episodes[0].hookBeat, hb, 'hookBeat 仍指向原来那一拍');
  ok(renderMarkdown(out, CTX).includes('第 1 场第 2 拍兑现'), '钩子显示的位置跟着后移');
}
{
  // 2.x 迁移：补 id，hookBeat [场, 拍] 换成节拍 id
  const old = clone(FIXTURE);
  for (const ep of old.episodes) {
    delete ep.id;
    for (const sc of ep.scenes) { delete sc.id; for (const bt of sc.flow) delete bt.id; }
    ep.hookBeat = [1, 1];
  }
  const m = migrateScript(old, OUTLINE, seededRng('m'));
  ok(m.episodes.every((e) => e.hookBeat === e.scenes[0].flow[0].id), 'hookBeat [1, 1] 换成第一场第一拍的 id');
  ok(gate(m, 'ids', CTX).ok && gate(m, 'hook-open').ok, '迁移结果过 id 门与钩子门');
  const bad = clone(old); bad.episodes[0].hookBeat = [9, 9];
  let msg = '';
  try { migrateScript(bad, OUTLINE, seededRng('m')); } catch (e) { msg = e.message; }
  ok(msg.includes('第 1 集的 hookBeat [9, 9]'), 'hookBeat 指向不存在的节拍时迁移报错点名');
  msg = '';
  try { migrateScript(old, null); } catch (e) { msg = e.message; }
  ok(msg.includes('--outline'), '迁移必须给大纲');
}
{
  // 补 id 时新 id 计入已用集合：随机源连出两次同样的值，第二拍必须重抽
  const doc = clone(FIXTURE);
  delete doc.episodes[0].scenes[0].flow[0].id;
  delete doc.episodes[0].scenes[1].flow[0].id;
  let n = 0;
  const repeating = () => (n++ < 16 ? 0 : 1);
  const out = assignScriptIds(doc, { outline: OUTLINE, rng: repeating });
  const [a, b] = [out.episodes[0].scenes[0].flow[0].id, out.episodes[0].scenes[1].flow[0].id];
  ok(isId(a, 'bt') && isId(b, 'bt') && a !== b, '跨场补的节拍 id 不撞号');
}
{
  // 大纲在第 2 集前插了一集并 renumber：剧本按集 id 刷新集号
  const outline = clone(OUTLINE);
  outline.episodes.splice(1, 0, { ...clone(outline.episodes[1]), id: 'ep_zzzzzzzz' });
  outline.episodes = outline.episodes.map((e, i) => ({ ...e, ep: i + 1 }));
  const ctx = { ...CTX, outline };
  ok(!gate(FIXTURE, 'ids', ctx).ok, '大纲插集后剧本的集号被 ids 门点名');
  const before = JSON.stringify(FIXTURE);
  const re = renumberScript(FIXTURE, outline);
  eq(JSON.stringify(FIXTURE), before, 'renumberScript 不改入参');
  eq(re.episodes.map((e) => e.ep).join(','), '1,3,4,5,6,7', '集号改成大纲里的集号');
  ok(re.episodes.every((e, i) => e.id === FIXTURE.episodes[i].id), '集 id 不动');
  ok(gate(re, 'ids', ctx).ok, 'renumber 后 ids 门通过');
  const orphan = clone(FIXTURE); orphan.episodes[0].id = 'ep_yyyyyyyy';
  eq(renumberScript(orphan, outline).episodes[0].ep, 1, '集 id 不在大纲里的集原样保留（交给 ids 门点名）');
}
{
  // CLI
  const SCRIPT = join(here, 'novel-script.mjs');
  const OUTLINE_PATH = join(here, '../references/test-fixtures/upstream/渡口-outline.json');
  const dir = mkdtempSync(join(tmpdir(), 'script-ids-'));
  const file = join(dir, 'script.json');
  const raw = clone(FIXTURE);
  for (const sc of raw.episodes[0].scenes) delete sc.id;
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const printed = run('ids', file, '--outline', OUTLINE_PATH, '--seed', 'cli');
  eq(printed.status, 0, 'ids 正常退出');
  ok(JSON.parse(printed.stdout).episodes[0].scenes.every((s) => isId(s.id, 'sc')), 'ids 打印补好 id 的 JSON');
  const fresh = JSON.parse(run('ids', file).stdout).episodes[0].scenes.map((s) => s.id);
  ok(fresh.every((id) => isId(id, 'sc')) && !fresh.some((id) => JSON.parse(printed.stdout).episodes[0].scenes.some((s) => s.id === id)), '不带 --seed 走加密随机，与带种子的结果不同');
  const again = JSON.parse(run('ids', file).stdout).episodes[0].scenes.map((s) => s.id);
  ok(!again.some((id) => fresh.includes(id)), '不带 --seed 两次补出的 id 互不相同');
  eq(run('ids', file, '--outline', OUTLINE_PATH, '--seed', 'cli', '--write').status, 0, 'ids --write 正常退出');
  const once = readFileSync(file, 'utf8');
  ok(once !== JSON.stringify(raw, null, 2) + '\n' && JSON.parse(once).episodes[0].scenes.every((s) => isId(s.id, 'sc')), 'ids --write 真的写回了文件');
  run('ids', file, '--write');
  eq(readFileSync(file, 'utf8'), once, 'ids 幂等');
  eq(run('migrate', file).status, 1, 'migrate 缺 --outline 报错');
  eq(run('renumber', file).status, 1, 'renumber 缺 --outline 报错');
  eq(run('renumber', file, '--outline', OUTLINE_PATH, '--write').status, 0, 'renumber --write 正常退出');
  eq(readFileSync(file, 'utf8'), once, '集号本来就对时 renumber 不改文件');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`✓ ${passed} 项自测全部通过`);

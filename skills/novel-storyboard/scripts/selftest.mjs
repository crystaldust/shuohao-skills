#!/usr/bin/env node
// novel-storyboard 自测：不调模型、不花额度，只验确定性逻辑。
// 原则与仓库里其他 skill 一致：每道质量门都要有击穿用例——
// 证明它真的会拦，不是一个永远为真的假测试。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isId, seededRng } from './ids.mjs';
import {
  assignStoryboardIds,
  migrateStoryboard,
  renumberStoryboard,
  segLabel,
  CAMERA_MOVES,
  DEFAULT_PARAMS,
  exportPack,
  H3_I2VA_LINE,
  SHOT_SIZES,
  computeStats,
  cutStarts,
  expandScript,
  GATE_LOG,
  gateLogEntries,
  gateReport,
  summarizeGateLog,
  h3AlignmentLine,
  h3CutSlices,
  h3CutTime,
  h3Remainder,
  loadRecipes,
  parseCardFields,
  paramsOf,
  recipeDrift,
  renderHtml,
  renderMarkdown,
  SEEDANCE_NO_SUBTITLES,
  SEEDANCE_NO_TWINS,
  seedancePrompt,
  seedFromScript,
  segSeconds,
  slug,
  validateStoryboard,
} from './novel-storyboard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, '../examples/渡口-storyboard.json'), 'utf8'));
const SCRIPT = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-script.json'), 'utf8'));
const OUTLINE = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-outline.json'), 'utf8'));
const CAST = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-cast.json'), 'utf8'));
const ART = JSON.parse(readFileSync(join(here, '../references/test-fixtures/upstream/渡口-art.json'), 'utf8'));
const CTX = { script: SCRIPT, outline: OUTLINE, cast: CAST, art: ART };

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
const gate = (doc, id, ctx = CTX) => gateReport(doc, ctx).find((g) => g.id === id);
/** 按显示标签 E01-05 取段（标签按位置推算，段的身份是 id）。 */
const segAt = (doc, label) => {
  const [, e, s] = /^E(\d+)-(\d+)$/.exec(label);
  return doc.episodes.find((x) => x.ep === Number(e)).segments[Number(s) - 1];
};
const SC = SCRIPT.episodes[0].scenes; // 剧本第 1 集的两场
const S1 = SC[0].flow.map((b) => b.id); // 第 1 场的节拍 id
const S2 = SC[1].flow.map((b) => b.id);

/* ---------------- expandScript ---------------- */

const expanded = expandScript(SCRIPT);
eq(expanded.size, 6, '剧本六集全部展开');
const e1 = expanded.get(SCRIPT.episodes[0].id);
eq(e1.ep, 1, '按集 id 取，集号只是显示');
eq(e1.scenes[0].id, SC[0].id, '每场带场次 id');
eq(e1.scenes[1].n, 2, '场的位置现算');
eq(e1.scenes[0].beats[3].id, S1[3], '每拍带节拍 id');
eq(e1.scenes[0].byId.get(S1[3]).n, 4, '按节拍 id 查到位置');
eq(segLabel(1, 4), 'E01-05', '段标签 = 集号 + 段在集内的位置');
eq(e1.scenes.length, 2, '第 1 集两场');
eq(e1.scenes[0].beats.length, 13, '第 1 场 13 拍');
eq(e1.scenes[1].beats.length, 22, '第 2 场 22 拍');
eq(e1.scenes[0].beats[0].kind, 'action', '第 1 拍是动作');
eq(e1.scenes[0].beats[0].seconds, 2.5, '动作按 2.5 秒计');
eq(e1.scenes[0].beats[2].speaker, 'C03', '台词带说话人');
eq(e1.targetSeconds, 120, '目标秒数带出来');
eq(expandScript(null).size, 0, '空剧本不崩');

/* ---------------- H3 骨架推导 ---------------- */

eq(h3CutTime(3), '00:03.000', '切点时刻格式 分:秒.毫秒');
eq(h3CutTime(6.5), '00:06.500', '半秒切点');
eq(h3CutTime(65), '01:05.000', '过分钟进位');
eq(cutStarts([{ seconds: 3 }, { seconds: 4 }, { seconds: 3 }]).join(','), '0,3,7', '切点 = 前面分镜秒数累计');
eq(h3AlignmentLine([{ seconds: 5 }]), H3_I2VA_LINE, '默认英文：单分镜的段用官方 I2VA 固定句式');
eq(h3AlignmentLine([{ seconds: 5 }], 'zh'), '目标视频在 0.00 秒处完全参照图 1（来自镜头 1）。', 'zh 模式有中文 I2VA 句式');
{
  const line = h3AlignmentLine([{ seconds: 3 }, { seconds: 4 }]);
  ok(line.startsWith('How the reference pictures align with the target video — '), '默认英文：多分镜用官方对齐句式');
  ok(line.includes('Picture 1 (from Shot 1) aligns with the 0.00-second mark'), '主分镜图钉 0.00 秒');
  ok(line.includes('Picture 2 (from Shot 2) aligns with the 3.00-second mark'), '子分镜图钉自己的切点');
  ok(h3AlignmentLine([{ seconds: 3 }, { seconds: 4 }], 'zh').includes('图 2（来自镜头 2）对齐目标视频 3.00 秒处'), 'zh 模式对齐句式可用');
}
{
  const slices = h3CutSlices('integrated_multimodal_description:\n[Shot 1] aa\n[Shot 2] bb\n\noverall_soundscape: x', 2);
  ok(slices[0].includes('aa') && !slices[0].includes('bb'), '[Shot k] 切片互不越界');
  ok(slices[1].includes('bb') && !slices[1].includes('x'), '切片不吃到声景字段');
  const zh = h3CutSlices('整体视听描述：\n[镜头 1] aa\n[镜头 2] bb\n\n整体音景：x', 2, 'zh');
  ok(zh[0].includes('aa') && zh[1].includes('bb'), 'zh 模式按 [镜头 k] 切片');
}
eq(segSeconds({ cuts: [{ seconds: 3 }, { seconds: 4.5 }] }), 7.5, '段秒数 = 分镜求和');

/* ---------------- computeStats ---------------- */

const stats = computeStats(FIXTURE, SCRIPT);
eq(stats.totals.segments, 10, '样例十段');
eq(stats.totals.cuts, 34, '样例三十四个分镜');
eq(stats.totals.seconds, 119, '总秒数');
eq(stats.totals.targetSeconds, 120, '目标秒数');
ok(stats.totals.avgCutSeconds >= 3 && stats.totals.avgCutSeconds <= 4, '平均一切 3 秒左右——短剧节奏');
eq(stats.batches.length, 2, '两个生成批次（S02 浓雾清晨 / S01 晨雾）');
ok(stats.batches[0].segments.length + stats.batches[1].segments.length === 10, '批次覆盖全部段');
eq(stats.dialogue.length, 19, '第 1 集 19 句台词全部对到段和切');
ok(stats.dialogue.every((d) => /^E01-\d{2}$/.test(d.label) && d.cut >= 1), '对齐单带段标签和切序');
ok(stats.dialogue.every((d) => isId(d.segment, 'sg') && isId(d.cutId, 'ct')), '对齐单按段 id、切 id 对回素材');
ok(stats.batches.every((b) => b.labels.length === b.segments.length), '批次同时给段 id 与段标签');
eq(stats.episodes[0].withLines, 10, '台词段计数——本样例每段都带台词，纯画面收在分镜级');
eq(paramsOf({}).maxSegmentSeconds, DEFAULT_PARAMS.maxSegmentSeconds, '默认段上限 15 秒');
eq(paramsOf({}).maxCutSeconds, 5, '默认分镜上限 5 秒');
eq(paramsOf({ params: { maxCutSeconds: 4 } }).maxCutSeconds, 4, '分镜上限可调');

/* ---------------- 质量门：全绿基线 ---------------- */

ok(gateReport(FIXTURE, CTX).every((g) => g.ok), '样例带全部上游全部门通过');
eq(gateReport(FIXTURE, CTX).length, 18, '十八道门');
eq(gateReport(FIXTURE, CTX)[0].id, 'ids', 'id 门排第一');
ok(!gateReport(FIXTURE, CTX).some((g) => g.id === 'segment-id'), '段号连号门已经删掉');
{
  const gates = gateReport(FIXTURE, {});
  ok(gates.every((g) => g.ok), '不带上游也通过（对账门跳过）');
  ok(gates.find((g) => g.id === 'coverage').detail.includes('跳过'), '跳过要明说，不静默');
}

/* ---------------- 质量门：逐门击穿 ---------------- */

// ids — 集 / 段 / 切 id 齐全一致，场次与节拍引用剧本 id
{
  const idsOf = (mutate, ctx = CTX) => {
    const doc = clone(FIXTURE);
    mutate(doc);
    return gate(doc, 'ids', ctx);
  };
  ok(gate(FIXTURE, 'ids').ok, '样例 id 齐全');
  ok(gate(FIXTURE, 'ids', {}).ok, '不给剧本也查本文件内的格式与唯一');
  let g = idsOf((d) => delete segAt(d, 'E01-02').id);
  ok(!g.ok && g.detail.includes('E01-02 缺段 id（运行 ids --write）'), '段缺 id 被拦，点名段标签');
  g = idsOf((d) => (segAt(d, 'E01-02').id = 'E01-02'));
  ok(g.detail.includes('E01-02 的段 id「E01-02」格式不对'), '2.x 段号不再是合法 id');
  g = idsOf((d) => delete segAt(d, 'E01-02').cuts[0].id);
  ok(g.detail.includes('E01-02#1 缺切 id'), '切缺 id 被拦');
  g = idsOf((d) => (segAt(d, 'E01-03').id = segAt(d, 'E01-02').id));
  ok(g.detail.includes(`段 id ${segAt(FIXTURE, 'E01-02').id} 重复`), '段 id 重复被拦');
  g = idsOf((d) => (segAt(d, 'E01-02').cuts[1].id = segAt(d, 'E01-01').cuts[0].id));
  ok(g.detail.includes(`切 id ${segAt(FIXTURE, 'E01-01').cuts[0].id} 重复`), '跨段的切 id 重复被拦');
  g = idsOf((d) => delete d.episodes[0].id);
  ok(g.detail.includes('E01 缺集 id'), '集缺 id 被拦');
  g = idsOf((d) => (d.episodes[0].id = 'ep_zzzzzzzz'));
  ok(g.detail.includes('E01 的集 id 不在剧本里'), '集 id 不在剧本被拦');
  g = idsOf((d) => (d.episodes[0].ep = 2));
  ok(g.detail.includes('E02 的集 id 在剧本里是第 1 集'), '集号过期被拦——显示缓存对照剧本');
  g = idsOf((d) => delete segAt(d, 'E01-02').sceneRef);
  ok(g.detail.includes('E01-02 缺 sceneRef'), '段缺 sceneRef 被拦');
  g = idsOf((d) => (segAt(d, 'E01-02').sceneRef = 'S01'));
  ok(g.detail.includes('E01-02 的 sceneRef「S01」格式不对'), 'sceneRef 写成场景编号被拦');
  g = idsOf((d) => (segAt(d, 'E01-02').sceneRef = SCRIPT.episodes[1].scenes[0].id));
  ok(g.detail.includes('E01-02 的 sceneRef 不在剧本第 1 集里'), 'sceneRef 指向别的集被拦');
  ok(idsOf((d) => (segAt(d, 'E01-02').sceneRef = SCRIPT.episodes[1].scenes[0].id), {}).ok, '不给剧本时不核对 sceneRef 指向');
  g = idsOf((d) => (segAt(d, 'E01-02').cuts[0].beatIds = []));
  ok(g.detail.includes('E01-02#1 缺 beatIds'), '空 beatIds 被拦');
  g = idsOf((d) => (segAt(d, 'E01-02').cuts[0].beatIds = [6]));
  ok(g.detail.includes('E01-02#1 的 beatIds 里「6」格式不对'), 'beatIds 写成拍号被拦');
  g = idsOf((d) => {
    const seg = segAt(d, 'E01-02');
    delete seg.sceneRef;
    seg.sceneIndex = 1;
    delete seg.cuts[0].beatIds;
    seg.cuts[0].beats = [6, 6];
  });
  ok(g.detail.includes('E01-02 还是 2.x 写法（sceneIndex）：运行 migrate --script'), '2.x 的 sceneIndex 点名并提示迁移');
  ok(g.detail.includes('E01-02#1 还是 2.x 写法（beats）'), '2.x 的 beats 区间点名');
}
// coverage — 按节拍 id 序列比对：漏拍 / 重拍 / 越场 / 乱序 / 整场没分镜 / 场次倒退
{
  const doc = clone(FIXTURE);
  segAt(doc, 'E01-01').cuts[3].beatIds = [S1[4]]; // 原来认领第 4、5 拍
  const g = gate(doc, 'coverage');
  ok(!g.ok, '有节拍没人认领被拦');
  ok(g.detail.includes(`第 4 拍（${S1[3]}）没人认领`), '点名到拍位与节拍 id');
}
{
  const doc = clone(FIXTURE);
  segAt(doc, 'E01-01').cuts[3].beatIds = [S1[2], S1[3], S1[4]];
  ok(gate(doc, 'coverage').detail.includes('第 1 场第 3 拍被 E01-01#3 和 E01-01#4 重复认领'), '重复认领点得出两个切');
}
{
  const doc = clone(FIXTURE);
  segAt(doc, 'E01-01').cuts[0].beatIds = [S2[0]];
  const g = gate(doc, 'coverage');
  ok(g.detail.includes(`E01-01#1 认领的 ${S2[0]} 不在 E01 第 1 场`), '认领别的场的节拍被拦');
}
{
  const doc = clone(FIXTURE);
  const cuts = segAt(doc, 'E01-01').cuts;
  [cuts[0].beatIds, cuts[1].beatIds] = [cuts[1].beatIds, cuts[0].beatIds];
  const g = gate(doc, 'coverage');
  ok(!g.ok && g.detail.includes('第 1 场从第 1 拍起认领乱序'), '不重不漏但顺序错被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments = doc.episodes[0].segments.filter((s) => s.sceneRef !== SC[0].id);
  ok(gate(doc, 'coverage').detail.includes('整场没有分镜'), '整场空白被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[1].sceneRef = SC[1].id; // E01-02 先进第 2 场，E01-03 又回到第 1 场
  const g = gate(doc, 'coverage');
  ok(!g.ok && g.detail.includes('E01-03 场次顺序倒退'), '场次顺序穿插被拦');
}
{
  // 剧本在第 1 场第 4、5 拍之间插一拍：只有这一拍没人认领，其余认领原样有效
  const script = clone(SCRIPT);
  script.episodes[0].scenes[0].flow.splice(4, 0, { id: 'bt_zzzzzzzz', action: '雾里传来一声汽笛。' });
  const ctx = { ...CTX, script };
  const g = gate(FIXTURE, 'coverage', ctx);
  eq(g.detail, 'E01 第 1 场第 5 拍（bt_zzzzzzzz）没人认领', '剧本插一拍：覆盖门只点名新的那一拍');
  ok(gate(FIXTURE, 'dialogue-fit', ctx).ok && gate(FIXTURE, 'h3-dialogue', ctx).ok, '剧本插一拍：台词仍按 id 对上原来的切');
  ok(gate(FIXTURE, 'ids', ctx).ok, '剧本插一拍：分镜的 id 引用全部仍有效');
}
// segment-cap
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].seconds = 15; // 段总秒数 27
  const g = gate(doc, 'segment-cap');
  ok(!g.ok, '段超 15 秒被拦');
  ok(g.detail.includes('E01-01'), '点名到段');
}
// cut-length
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].seconds = 1;
  ok(!gate(doc, 'cut-length').ok, '分镜短于 2 秒被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].seconds = 6;
  const g = gate(doc, 'cut-length');
  ok(!g.ok, '分镜超 5 秒被拦——3 秒节奏是硬门');
  ok(g.detail.includes('E01-01#1'), '点名到切');
}
{
  const doc = clone(FIXTURE);
  doc.params = { maxCutSeconds: 3 };
  ok(!gate(doc, 'cut-length').ok, '上限收紧到 3 秒后原样例不再达标');
}
// dialogue-fit
{
  const doc = clone(FIXTURE);
  const seg = segAt(doc, 'E01-05');
  seg.cuts[0].seconds = 4; // 台词 4.4 秒
  const g = gate(doc, 'dialogue-fit');
  ok(!g.ok, '台词装不进分镜被拦');
  ok(g.detail.includes('E01-05#1'), '点名到切');
}
// ep-duration
{
  const doc = clone(FIXTURE);
  for (const s of doc.episodes[0].segments) for (const c of s.cuts) c.seconds = Math.min(5, c.seconds + 2);
  ok(gate(doc, 'ep-duration').detail.includes('超'), '写超总时长被拦');
}
{
  const doc = clone(FIXTURE);
  for (const s of doc.episodes[0].segments) for (const c of s.cuts) c.seconds = Math.max(2, c.seconds - 2);
  ok(gate(doc, 'ep-duration').detail.includes('欠'), '写欠总时长被拦');
}
// crowd
{
  const doc = clone(FIXTURE);
  const cut = segAt(doc, 'E01-09').cuts[2];
  cut.characters = ['C01', 'C02', 'C03', 'C04'];
  ok(!gate(doc, 'crowd').ok, '四人同框无拆解说明被拦');
  cut.note = '全景交代后立刻切正反打';
  ok(gate(doc, 'crowd').ok, '带拆解说明就放行');
}
// size-phrase
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].frame = '浓雾清晨的河岸土路，沈知微抱着旧皮箱';
  ok(!gate(doc, 'size-phrase').ok, '分镜图提示词缺景别词被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].size = '大远景';
  ok(!gate(doc, 'size-phrase').ok, '景别不在枚举里被拦');
}
// camera-phrase
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].camera = '推';
  ok(!gate(doc, 'camera-phrase').ok, '运镜不在 H3 词表里被拦');
}
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments[0];
  seg.h3Prompt = seg.h3Prompt.replace('a tracking shot follows her', 'the camera follows her');
  const g = gate(doc, 'camera-phrase');
  ok(!g.ok, '运镜词没写进自己的 [Shot k] 段落被拦');
  ok(g.detail.includes('E01-01#1'), '点名到切');
}
// h3-structure — 对齐指令由分镜结构推导，逐字对账
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].seconds = 4; // 时长改了、提示词没跟着改
  ok(gate(doc, 'h3-structure').detail.includes('对不上'), '分镜秒数一改，旧对齐指令立刻对不上');
}
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments[0];
  seg.h3Prompt = seg.h3Prompt.replace('[Shot 2] At 00:03.000,', '[Shot 2] At 00:03.500,');
  const g = gate(doc, 'h3-structure');
  ok(!g.ok, '切点时刻和分镜秒数累计不一致被拦');
  ok(g.detail.includes('切点时刻'), '报出哪一处时刻错了');
}
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments[0];
  seg.h3Prompt = seg.h3Prompt.replace('overall_soundscape:', 'ambient_sound:');
  ok(gate(doc, 'h3-structure').detail.includes('核心字段'), '三字段缺失被拦');
}
// h3-dialogue
{
  const doc = clone(FIXTURE);
  const seg = doc.episodes[0].segments[0];
  seg.h3Prompt = seg.h3Prompt.replace('上船喽——过河的抓紧，雾要变天。', 'the ferryman calls out.');
  const g = gate(doc, 'h3-dialogue');
  ok(!g.ok, '台词没进 <d> 块被拦');
  ok(gate(doc, 'h3-dialogue', {}).detail.includes('跳过'), '没给剧本时本门跳过并明说');
}
// h3-lang — 语言与设定双向对账（默认英文 = 官方口径）
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].h3Prompt += ' 浓雾弥漫。';
  ok(!gate(doc, 'h3-lang').ok, '英文提示词在 <d> 台词之外混中文被拦');
}
{
  const doc = clone(FIXTURE);
  doc.promptLang = 'zh';
  ok(!gate(doc, 'h3-lang').ok, '设定中文、正文却是英文被拦——语言开关双向都管');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].h3Prompt = doc.episodes[0].segments[0].h3Prompt.replace('the old ferryman squatting', '老周 squatting');
  ok(!gate(doc, 'prompt-no-names').ok, '英文模式下 H3 提示词里的人名被拦');
}
{
  const doc = clone(FIXTURE);
  doc.promptLang = 'zh';
  doc.episodes[0].segments[0].h3Prompt += ' 老周站在船头。';
  ok(!gate(doc, 'prompt-no-names').ok, '中文模式 H3 提示词同样禁人名——官方规范，不跟着语言变');
}
eq(h3Remainder('a <d>[Chinese] 你好</d> b "营业中" c'), 'a   b   c', 'h3Remainder 剔除 <d> 块与画面文字');
// frame-prompt
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].frame = 'medium shot of a young woman running through fog';
  ok(!gate(doc, 'frame-prompt').ok, '分镜图提示词写成英文被拦——它是中文');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].frame = '  ';
  ok(!gate(doc, 'frame-prompt').ok, '空分镜图提示词被拦');
}
// prompt-no-names：分镜图直呼其名，视频正文禁名
ok(FIXTURE.episodes[0].segments[0].cuts[0].frame.includes('沈知微'), '样例的分镜图提示词直呼其名');
ok(gate(FIXTURE, 'prompt-no-names').ok, '分镜图提示词里的名字放行——它指向挂上去的那张设定图');
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].shot += '，沈知微回头看了一眼';
  const g = gate(doc, 'prompt-no-names');
  ok(!g.ok, 'Seedance 镜头正文出现角色名被拦');
  ok(g.detail.includes('E01-01#1'), '点名到切');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[1].shot += '，老伯蹲着'; // cast 里的别名
  ok(!gate(doc, 'prompt-no-names').ok, '角色别名也拦');
}
// composition
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].segments[2].blocking;
  const g = gate(doc, 'composition');
  ok(!g.ok, '段缺 blocking 被拦——纯参考图出片时它是唯一说清人在哪的地方');
  ok(g.detail.includes('E01-03'), '点名到段');
}
{
  const doc = clone(FIXTURE);
  delete doc.episodes[0].segments[0].cuts[2].lens;
  delete doc.episodes[0].segments[0].cuts[2].eyeline;
  const g = gate(doc, 'composition');
  ok(!g.ok && g.detail.includes('E01-01#3') && g.detail.includes('lens / eyeline'), '缺哪几项逐项点名');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].stability = '晃';
  ok(!gate(doc, 'composition').ok, 'stability 不在枚举里被拦');
}
// seedance-shot
for (const [bad, why] of [
  ['', '缺镜头正文'],
  ['A young woman runs through the fog.', '英文'],
  ['年轻女子跑了 3 秒', '写了秒数'],
  ['00:03 年轻女子停下', '写了时间码'],
  ['【镜头1】年轻女子停下', '写了镜头编号'],
  ['年轻女子停下（构图参考 @图片2）', '写了图片引用'],
  ['[Shot 2] 年轻女子停下', '写了 H3 标记'],
  ['年轻女子说{不劳烦}', '台词自己写了 {}'],
]) {
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].shot = bad;
  ok(!gate(doc, 'seedance-shot').ok, `Seedance 镜头正文${why}被拦`);
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].soundscape = '<脚步声>';
  doc.episodes[0].segments[0].music = '（低音弦乐）';
  const g = gate(doc, 'seedance-shot');
  ok(!g.ok && g.detail.includes('soundscape') && g.detail.includes('music'), '声景与配乐自带符号被拦——程序会套');
}
// refs
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].characters = ['C05'];
  ok(!gate(doc, 'refs').ok, '不在该场的人物被拦');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].props = ['P02'];
  ok(!gate(doc, 'refs').ok, '不在该场的道具被拦');
}

/* ---------------- 镜头配方卡库（可选挂载） ---------------- */
/*
 * 受限 frontmatter 解析是本 skill 自己写的（刻意不 import shot-recipes.mjs，
 * 两个 skill 谁没有谁都能跑），所以解析器、加载器、门三层都要有断言。
 */

{
  const card = parseCardFields(`---
id: demo-card
name: 演示卡
name_en: Demo Card
category: dialogue
cuts: [2, 3]
sizes: [medium, close]
cameras: [Static Shot, Push In]
must_phrases: [over-the-shoulder, blurred foreground shoulder]
---

## 意图

正文一概不读。
`);
  eq(card.id, 'demo-card', '受限解析取到 id');
  eq(card.name_en, 'Demo Card', '英文卡名也是机器字段');
  eq(card.cuts.join(','), '2,3', '行内数组里的整数转成数字');
  eq(card.must_phrases.length, 2, '必备短语按逗号切开');
  eq(card.category, undefined, '门用不到的字段一概不收');
  eq(parseCardFields('没有 frontmatter'), null, '没有 frontmatter 就不是卡片');
  eq(parseCardFields('---\nname: 无 id\n---\n'), null, '没有 id 就不是卡片');
}

const CARDS = loadRecipes(join(here, '../references/test-fixtures/shot-recipes'));

/* ---------------- 提示词规范的分层 ---------------- */

// 镜头正文的内容规则只在 shot-writing.md 写一遍；两份协议规范都以它为前提。
// 以前 H3 那份有「常见动作原则」而 Seedance 那份没有——两份副本必然发生的事。
{
  const refs = join(here, '../references');
  const common = readFileSync(join(refs, 'shot-writing.md'), 'utf8');
  const h3 = readFileSync(join(refs, 'h3-prompt.md'), 'utf8');
  const seedance = readFileSync(join(refs, 'seedance-prompt.md'), 'utf8');
  ok(common.includes('常见动作原则'), '共同层写了常见动作原则');
  ok(h3.includes('shot-writing.md') && seedance.includes('shot-writing.md'), '两份协议规范都指向共同层');
  // 画风由调用方在出片时附加；写死在结构示例里，模型会照抄
  ok(!/cold gray-green|冷灰绿|Cinematic, live-action/.test(h3), 'H3 规范的示例里不再写死画风');
  // Seedance 的时间轴与编号由程序拼，正文里出现就会重复或错位
  // 规范里会点名那些不许出现的标记；把带禁止词的行整行去掉后，剩下的正文不该再有它们
  const seedanceTaught = seedance.split('\n').filter((line) => !/不写|不加|不用|不要|禁/.test(line)).join('\n');
  ok(!/\[Shot \d|<Picture|<d>/.test(seedanceTaught), 'Seedance 规范不教 H3 语法（禁止列举除外）');
  // 官方符号规范：台词 {}、音效 <>、音乐（）。中文引号是我们以前自己编的
  ok(/台词[^\n]*`\{\}`/.test(seedance), 'Seedance 规范采用官方的 {} 台词符号');
  ok(/音效[^\n]*`<>`/.test(seedance) && /音乐[^\n]*`（）`/.test(seedance), 'Seedance 规范采用官方的 <> 与（）符号');
  // 官方明说精确秒数不稳定，时间层用镜头顺序
  ok(/不写[^\n]*0–3 秒/.test(seedance), 'Seedance 规范禁止正文写秒数');
  ok(/一个镜头只指定一种运镜/.test(seedance), 'Seedance 规范要求单一运镜');
  ok(/不用三视图/.test(seedance), 'Seedance 规范禁用多视图参考');
  // 动作四条住在共同层，两边共用
  ok(/情绪外化/.test(common) && /肢体细化/.test(common), '共同层并入了官方的动作写法');
}
eq(CARDS.size, 3, '最小卡片夹具三张全读出');
ok(CARDS.get('ots-shot-reverse').must_phrases.includes('over-the-shoulder'), '真实卡片的必备短语读得出来');
eq(CARDS.get('ots-shot-reverse').cuts[0], 2, '真实卡片的格数下限读得出来');
eq(loadRecipes(join(here, '../不存在的目录')).size, 0, '目录不存在不崩');

const SHOTS = { ...CTX, recipes: CARDS };
// 合规引用：两格连排的过肩正反打，必备短语逐条进 frame
const withRecipe = () => {
  const doc = clone(FIXTURE);
  const cuts = segAt(doc, 'E01-05').cuts;
  for (const i of [0, 1]) {
    cuts[i].recipe = 'ots-shot-reverse';
    cuts[i].frame += ', over-the-shoulder framing with a blurred foreground shoulder';
  }
  return doc;
};

// 跳过条件是「没给 --shots」，不是「没有 cut 带 recipe」
{
  const g = gate(FIXTURE, 'shot-recipe');
  ok(g.ok, '没挂卡库本门通过');
  ok(g.detail.includes('跳过'), '跳过要明说，不静默');
}
{
  // 夹具本身有两处真实引用（E01-06#1 hands-tell / E01-09#1 insert-beat），
  // 所以「全篇没引用」这一条要拿剥掉 recipe 的副本来试
  const bare = JSON.parse(JSON.stringify(FIXTURE));
  for (const s of bare.episodes.flatMap((e) => e.segments)) for (const c of s.cuts) delete c.recipe;
  const g = gate(bare, 'shot-recipe', SHOTS);
  ok(g.ok, '挂了卡库但全篇没引用配方也算通过');
  eq(g.detail, '本批分镜没有引用配方', '没引用同样明说，不静默');
}
{
  // 样例即规范：夹具里真的挂了配方，而且挂了之后这道门是过的
  const refs = FIXTURE.episodes.flatMap((e) => e.segments).flatMap((s) => s.cuts).filter((c) => c.recipe);
  eq(refs.length, 2, '夹具有两处真实配方引用');
  const g = gate(FIXTURE, 'shot-recipe', SHOTS);
  ok(g.ok, '夹具的配方引用全过');
  eq(g.detail, '', '全过不留备注');
}
{
  const g = gate(withRecipe(), 'shot-recipe', SHOTS);
  ok(g.ok, '合规引用全过');
  eq(g.detail, '', '全过不留备注');
}
// 击穿一：id 不在卡库
{
  const doc = withRecipe();
  segAt(doc, 'E01-05').cuts[0].recipe = 'no-such-card';
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '引用不存在的配方被拦');
  ok(g.detail.includes('E01-05#1') && g.detail.includes('不在配方库里'), '点名到段号#切序');
}
// 击穿二：必备短语没进 frame
{
  const doc = withRecipe();
  const cuts = segAt(doc, 'E01-05').cuts;
  cuts[1].frame = cuts[1].frame.replace('blurred foreground shoulder', 'soft foreground');
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '必备短语没进分镜图提示词被拦');
  ok(g.detail.includes('E01-05#2'), '点名到切');
  ok(g.detail.includes('过肩正反打') && g.detail.includes('blurred foreground shoulder'), '配方名 + 缺的短语原文——与 shot-recipes 的 check 措辞一致');
}
{
  const doc = withRecipe();
  const cuts = segAt(doc, 'E01-05').cuts;
  cuts[0].frame = cuts[0].frame.replace('over-the-shoulder', 'Over-The-Shoulder');
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '短语判定两边小写化，大小写不影响');
}
// 击穿三：多格配方的连排长度不够
{
  const doc = withRecipe();
  delete segAt(doc, 'E01-05').cuts[1].recipe;
  const g = gate(doc, 'shot-recipe', SHOTS);
  ok(!g.ok, '两格配方只挂一格被拦');
  ok(g.detail.includes('E01-05#1') && g.detail.includes('要 2 格连排'), '多格配方靠连续同 recipe 的分镜表达');
}
// 建议景别／运镜不设门，只在报告里提示偏离
{
  const doc = withRecipe();
  const cut = segAt(doc, 'E01-05').cuts[0];
  cut.size = 'extreme-wide';
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '建议景别偏离不设门——配方是语汇不是法条');
  const d = recipeDrift(cut, CARDS.get('ots-shot-reverse'));
  eq(d.sizes.join(' / '), 'medium / close', '偏离时报出建议景别');
  eq(d.cameras.length, 0, '运镜没偏离就不报');
  eq(recipeDrift(cut, null).sizes.length, 0, '没有卡片就没有偏离可言');
}
// recipe 不进结构检查——照 note 这个可选字段的先例办
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].recipe = 'no-such-card';
  eq(validateStoryboard(doc, CTX).length, 0, '不挂卡库时 recipe 不进结构检查');
}

/* ---------------- 门失败累积 ---------------- */

// 每次 validate 的结果本来跑完就没了，「模型最常违反哪条规则」只能靠印象。
// 纯函数 + CLI 负责 IO，所以这里不落盘也能验。
{
  const gates = [
    { id: 'cut-length', label: '每个分镜 2–5 秒', ok: false, detail: 'E01-01#1 9 秒' },
    { id: 'coverage', label: '节拍全覆盖', ok: true, detail: '' },
    { id: 'segment-cap', label: '每段 ≤ 15 秒', ok: false, detail: 'E01-01 共 21 秒' },
  ];
  const rows = gateLogEntries(gates, { doc: 'x.json', at: 'T0' });
  eq(rows.length, 3, '一次运行记一条 run + 每条失败一行');
  eq(rows[0].kind, 'run', '第一行是运行记录');
  eq(rows[0].gates, 3, 'run 记下这次跑了几道门');
  eq(rows[0].failed, 2, 'run 记下这次挂了几道');
  ok(rows.slice(1).every((r) => r.kind === 'fail'), '其余都是失败记录');
  ok(rows.every((r) => r.at === 'T0' && r.doc === 'x.json'), '时间与文档名逐行带上');
  eq(gateLogEntries([], {}).length, 0, '没有门就不写任何东西');

  const all = ['cut-length', 'coverage', 'segment-cap', 'refs'];
  const sum = summarizeGateLog([...rows, ...gateLogEntries(gates, { doc: 'y.json', at: 'T1' })], all);
  eq(sum.runs, 2, '统计跑过几次');
  eq(sum.cleanRuns, 0, '统计全过几次');
  eq(sum.fails, 4, '统计累计失败条数');
  eq(sum.ranked[0].gate, 'cut-length', '按失败次数排序，最常响的在前');
  eq(sum.ranked[0].count, 2, '同一道门跨运行累加');
  ok(sum.ranked[0].samples.length >= 1, '带上 detail 样本，供人看有没有该设而没设的门');
  eq(sum.silent.join(','), 'coverage,refs', '从没响过的门列出来——可能是死门，也可能规则已被内化');
  eq(summarizeGateLog([], all).silent.length, 4, '零日志时所有门都算没响过');
  eq(summarizeGateLog([null, 'x', { kind: 'run', failed: 0 }], all).runs, 1, '坏行跳过不炸');
}
eq(GATE_LOG, '.gates.jsonl', '日志文件名固定');

/* ---------------- Seedance 提示词（程序拼） ---------------- */

{
  const names = {
    char: (id) => new Map(OUTLINE.characters.map((c) => [c.id, c.name])).get(id) ?? id,
    scene: (id) => new Map(ART.scenes.map((x) => [x.id, x.name])).get(id) ?? id,
    prop: (id) => new Map(ART.props.map((x) => [x.id, x.name])).get(id) ?? id,
  };
  const ep1 = expandScript(SCRIPT).get(SCRIPT.episodes[0].id);
  const segOf = (label) => segAt(FIXTURE, label);
  const sceneOf = (seg) => ep1.scenes.find((s) => s.id === seg.sceneRef);
  const build = (id, extra = {}) => {
    const seg = segOf(id);
    return seedancePrompt(seg, { scene: sceneOf(seg), names, ...extra });
  };

  // 参考图路径（没有分镜图）：场景 → 人物 → 道具，名字就是附件标签
  const e06 = build('E01-06');
  eq(e06.refs.map((r) => r.label).join(','), '渡船船舱,沈知微,胡二爷,老周,旧皮箱', '附件顺序：场景 → 人物（首次出场序）→ 道具');
  ok(e06.prompt.startsWith('@[图片1] = 渡船船舱\n@[图片2] = 沈知微'), '先声明参考图，编号按附件顺序');
  ok(e06.refs.every((r) => r.kind === 'sheet' && r.file.endsWith('-sheet.png')), '参考图路径挂的是设定图');
  ok(e06.prompt.includes(`【人物关系与构图逻辑】\n${segOf('E01-06').blocking}`), '段级走位原样进');
  eq((e06.prompt.match(/【镜头\d+】/g) ?? []).length, 4, '每切一个【镜头k】，编号由程序加');
  ok(!/\d+(\.\d+)?\s*秒|\d{2}:\d{2}/.test(e06.prompt), '全文不写秒数——时间层用镜头顺序表达');
  ok(e06.prompt.includes('运镜：固定镜头\n景别：特写'), '运镜与景别用中文词');
  ok(e06.prompt.includes('台词：{船上有个规矩——不问来路，不碰行李。}'), '认领的台词逐字进 {}');
  ok(e06.prompt.includes('【镜头1】') && e06.prompt.split('【镜头2】')[0].includes('台词：{}'), '不说话的镜头写 {}');
  ok(e06.prompt.includes('音效：手掌拍在皮面上的一声闷响'), '镜级音效有才出');
  eq((e06.prompt.match(/^音效：/gm) ?? []).length, 1, '没填 sfx 的镜头没有音效行');
  ok(e06.prompt.includes('稳定性：稳定'), '稳定性枚举转中文');
  ok(e06.prompt.includes(`<${segOf('E01-06').soundscape}>`), '段级声景套 <>');
  ok(!/^（/m.test(e06.prompt), '没有配乐就没有配乐行');
  ok(e06.prompt.endsWith(`【约束】\n1. ${SEEDANCE_NO_SUBTITLES}\n2. ${SEEDANCE_NO_TWINS}`), '约束编号：无字幕；多人同框加禁双胞胎');
  ok(!/视觉风格|画风|cinematic/i.test(e06.prompt), '不写画风——视觉风格由调用方附加');

  // 画外音：{} 外面标「以画外音说」
  ok(build('E01-10').prompt.includes('台词：以画外音说{谁都别碰它。到了县城，它就是我全部的话。}'), '画外音按官方写法标在 {} 外');
  // 配乐套（）
  ok(build('E01-09').prompt.includes(`（${segOf('E01-09').music}）`), '段级配乐套（）');
  // 单人段不加禁双胞胎；调用方约束排在前面、不重复
  {
    const e10 = build('E01-10', { constraints: ['画面比例 16:9', SEEDANCE_NO_SUBTITLES] });
    ok(e10.prompt.endsWith(`【约束】\n1. 画面比例 16:9\n2. ${SEEDANCE_NO_SUBTITLES}`), '调用方约束在前、默认约束不重复、单人段不加禁双胞胎');
  }
  // 光影：镜级有才出
  ok(build('E01-10').prompt.includes('光影：远处一点暖黄灯光熄灭后只剩铜扣的冷光'), '镜级光影有才出');

  // 分镜路径：这一段每切都有分镜图 → 只挂分镜图，并在画面行注明构图参考
  {
    const all = build('E01-10', { image: (kind, rel) => (kind === 'frame' ? rel : null) });
    const s10 = segOf('E01-10');
    eq(all.refs.map((r) => r.file).join(','), s10.cuts.map((c) => `${s10.id}/${c.id}.png`).join(','), '分镜路径只挂分镜图，按段 id / 切 id 找');
    ok(all.prompt.includes('（构图参考 @图片1）') && all.prompt.includes('（构图参考 @图片2）'), '每镜注明构图参考哪张');
  }
  {
    const s10 = segOf('E01-10');
    const second = `${s10.id}/${s10.cuts[1].id}.png`;
    const part = build('E01-10', { image: (kind, rel) => (rel === second ? rel : null) });
    eq(part.refs.map((r) => r.kind).join(','), 'sheet,sheet,sheet,frame', '分镜图不全：设定图在前，已有的分镜图接在后面');
    ok(part.prompt.includes('（构图参考 @图片4）') && !part.prompt.split('【镜头2】')[0].includes('构图参考'), '只有有图的那一镜注明构图参考');
  }
  // 名字只出现在附件声明与走位里，镜头正文不出现
  {
    const body = e06.prompt.split('【镜头1】')[1];
    ok(!['沈知微', '胡二爷', '老周'].some((n) => body.includes(n)), '逐镜正文不含角色名');
  }
}

/* ---------------- exportPack（H3 投产包） ---------------- */

const SEG01 = segAt(FIXTURE, 'E01-01');
const SEG06 = segAt(FIXTURE, 'E01-06');
const picsOf = (seg, prefix = '') => seg.cuts.map((c) => `${prefix}${seg.id}/${c.id}.png`).join(',');
{
  const pack = exportPack(FIXTURE, SCRIPT, { imageExists: () => false });
  eq(pack.files.length, 11, '十段 prompt.md + 一份 manifest');
  ok(pack.files.some((f) => f.path === `${SEG01.id}/prompt.md`), '每段一个文件夹，按段 id 命名');
  const p01 = pack.files.find((f) => f.path === `${SEG01.id}/prompt.md`);
  ok(p01.content.startsWith('# E01-01 · H3 提示词'), 'prompt.md 标题用段标签');
  ok(p01.content.includes(`段 id：\`${SEG01.id}\``), 'prompt.md 写明段 id');
  ok(p01.content.includes(`Picture 1 = ${SEG01.cuts[0].id}.png（**首帧**，钉 0.00 秒）`), '明确指定哪个文件是首帧');
  ok(p01.content.includes(`Picture 4 = ${SEG01.cuts[3].id}.png（钉 10.00 秒）`), '每张图的切点秒数写明');
  ok(p01.content.includes('---\n\nHow the reference pictures align'), '分隔线以下是 h3Prompt 原样（官方英文口径）');
  ok(!JSON.stringify(pack).includes('recipe'), '配方是创作期语汇，H3 投产包里没有它的位置');
  const m = pack.manifest.find((x) => x.segment === SEG01.id);
  eq(m.pictures.join(','), picsOf(SEG01), 'Picture 序 = 切的顺序，文件按切 id 命名');
  eq(m.label, 'E01-01', 'manifest 带段标签');
  eq(m.order, 1, 'manifest 带顺序');
  eq(m.ep, 1, 'manifest 带集号');
  eq(pack.manifest.map((x) => x.order).join(','), '1,2,3,4,5,6,7,8,9,10', '顺序从 1 连续');
  eq(m.cutStarts.join(','), '0,3,6,10', 'manifest 带切点时刻表');
  eq(m.missing.length, 4, '缺图逐张标注');
  ok(pack.missingTotal > 0, '缺图总数上报');
}
{
  const pack = exportPack(FIXTURE, SCRIPT, { imageExists: () => true, dir: 'out' });
  eq(pack.missingTotal, 0, '图齐了就没有缺图标注');
  ok(pack.files.some((f) => f.path === 'out/manifest.json'), '--out 改导出目录');
  ok(pack.files.some((f) => f.path === `out/${SEG01.id}/prompt.md`), '段文件夹跟着 --out 走');
}
{
  // 重排两段：标签和顺序跟着变，段 id 与图片路径不变——已生成的素材按 id 对回
  const doc = clone(FIXTURE);
  const segs = doc.episodes[0].segments;
  [segs[0], segs[1]] = [segs[1], segs[0]];
  const before = exportPack(FIXTURE, SCRIPT).manifest.find((x) => x.segment === SEG01.id);
  const after = exportPack(doc, SCRIPT).manifest.find((x) => x.segment === SEG01.id);
  eq(`${before.label}→${after.label}`, 'E01-01→E01-02', '重排后段标签跟着位置变');
  eq(after.order, 2, '重排后顺序跟着变');
  eq(after.pictures.join(','), before.pictures.join(','), '重排后图片路径不变');
}

/* ---------------- exportPack（Seedance 投产包） ---------------- */

{
  const names = { char: (id) => new Map(OUTLINE.characters.map((c) => [c.id, c.name])).get(id) ?? id };
  const pack = exportPack(FIXTURE, SCRIPT, { protocol: 'seedance', names, sheetExists: (f) => f === '沈知微-sheet.png', dir: 'sd' });
  eq(pack.files.length, 11, '十段 seedance.md + 一份 seedance-manifest.json');
  ok(pack.files.some((f) => f.path === 'sd/seedance-manifest.json'), 'Seedance 的 manifest 另起名字，不跟 H3 撞');
  ok(!pack.files.some((f) => f.path.endsWith('prompt.md')), 'Seedance 包里没有 H3 的 prompt.md');
  const md = pack.files.find((f) => f.path === `sd/${SEG06.id}/seedance.md`).content;
  ok(md.startsWith('# E01-06 · Seedance 提示词'), 'seedance.md 带标题');
  ok(md.includes('- @图片2 = 沈知微 → ref-2.png'), '头部列出每个附件对应的包内文件');
  ok(md.includes('- @图片3 = 胡二爷 → ref-3.png（缺）'), '找不到的附件标「缺」');
  ok(md.includes('视觉风格（画风层）在提交时附加'), '明说画风不在包里');
  ok(md.includes('---\n\n@[图片1] = S01'), '分隔线以下是程序拼的提示词，不给 art 时场景退回 ID');
  const m = pack.manifest.find((x) => x.segment === SEG06.id);
  eq(m.label, 'E01-06', 'Seedance manifest 同样带段标签');
  eq(m.order, 6, 'Seedance manifest 同样带顺序');
  eq(m.attachments.length, 5, '附件逐个列出');
  eq(m.attachments[1].path, `sd/${SEG06.id}/ref-2.png`, '设定图拷成 ref-<n>.png');
  eq(m.missing.length, 4, '缺的附件逐个标注');
  ok(pack.copies.some((c) => c.file === '沈知微-sheet.png' && c.to === `sd/${SEG06.id}/ref-2.png`), '找得到的设定图交给 CLI 拷进包');
  ok(!JSON.stringify(pack).includes('recipe'), '配方同样不进 Seedance 包');
}
{
  // 分镜图齐了走分镜路径：附件就是包里的 <切 id>.png，不再挂设定图
  const pack = exportPack(FIXTURE, SCRIPT, { protocol: 'seedance', imageExists: () => true });
  const m = pack.manifest.find((x) => x.segment === SEG01.id);
  eq(m.attachments.map((a) => a.path).join(','), picsOf(SEG01), '分镜路径的附件就是分镜图');
  eq(pack.missingTotal, 0, '图齐了没有缺件');
  eq(pack.copies.length, 0, '分镜路径不拷设定图');
}

/* ---------------- validateStoryboard 结构检查 ---------------- */

eq(validateStoryboard(FIXTURE, CTX).length, 0, '样例零违规');
ok(validateStoryboard(null).length > 0, 'null 不崩');
ok(validateStoryboard({}).some((p) => p.includes('source')), '缺 source 报出来');
ok(validateStoryboard({ source: 'x', episodes: [] }).some((p) => p.includes('episodes')), '空 episodes 报出来');
{
  const doc = clone(FIXTURE);
  doc.aspectRatio = '1:1';
  ok(validateStoryboard(doc, CTX).some((p) => p.includes('aspectRatio')), '正式画幅只接受 16:9 或 9:16');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0] = { id: SEG01.id };
  const problems = validateStoryboard(doc, CTX);
  ok(problems.some((p) => p.includes('E01-01 缺 sceneRef')), '缺 sceneRef 报出来，点名段标签');
  ok(problems.some((p) => p.includes('h3Prompt')), '缺 H3 提示词报出来');
  ok(problems.some((p) => p.includes('没有分镜')), '缺 cuts 报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0] = { id: SEG01.cuts[0].id, beatIds: [S1[0]] };
  const problems = validateStoryboard(doc, CTX);
  ok(problems.some((p) => p.includes('seconds')), '分镜缺秒数报出来');
  ok(problems.some((p) => p.includes('frame')), '分镜缺分镜图提示词报出来');
}
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].beatIds = [];
  ok(validateStoryboard(doc, CTX).some((p) => p.includes('E01-01#1 缺 beatIds')), '空 beatIds 进结构检查');
}
{
  const doc = clone(FIXTURE);
  doc.episodes.push(clone(doc.episodes[0]));
  ok(validateStoryboard(doc, CTX).some((p) => p.includes('重复')), '重复集号报出来');
}

/* ---------------- seed ---------------- */

const seeded = seedFromScript(SCRIPT);
eq(seeded.source, '渡口', 'seed 带剧名');
eq(seeded.aspectRatio, '16:9', 'seed 默认写入正式横屏画幅');
eq(seeded.episodes.length, 6, 'seed 全六集');
eq(seeded.episodes[0].segments.length, 0, 'segments 留空给模型切');
eq(seeded.episodes[0].seedScenes.length, 2, '工作底稿带两场');
eq(seeded.episodes[0].seedScenes[0].beats.length, 13, '底稿带全部节拍');
ok(seeded.episodes[0].seedScenes[0].beats[0].seconds > 0, '每拍带秒数');
eq(seeded.episodes[0].id, SCRIPT.episodes[0].id, 'seed 照抄集 id');
eq(seeded.episodes[0].seedScenes[1].sceneRef, SC[1].id, 'seed 每场带 sceneRef');
eq(seeded.episodes[0].seedScenes[1].n, 2, 'seed 每场带位置，只用于显示');
eq(seeded.episodes[0].seedScenes[0].beats[4].id, S1[4], 'seed 每拍带节拍 id，认领时照抄');
{
  const raw = clone(SCRIPT);
  delete raw.episodes[0].scenes[0].flow[0].id;
  let msg = '';
  try { seedFromScript(raw); } catch (e) { msg = e.message; }
  ok(msg.includes('ids --write'), '剧本缺 id 时 seed 拒绝，并提示先补 id');
}
eq(seedFromScript(SCRIPT, [2, 3]).episodes.map((e) => e.ep).join(','), '2,3', '--eps 区间过滤');
eq(seedFromScript(SCRIPT, null, '9:16').aspectRatio, '9:16', '--aspect 写入正式竖屏画幅');
ok((() => { try { seedFromScript(SCRIPT, null, '1:1'); return false; } catch (e) { return /aspectRatio/.test(e.message); } })(), 'seed 拒绝不支持的画幅');
eq(seedFromScript({}).episodes.length, 0, '空剧本不崩');

/* ---------------- slug / 枚举 ---------------- */

eq(slug('渡口'), '渡口', '中文原样');
eq(slug('  '), 'storyboard', '空名兜底');
ok(Object.values(SHOT_SIZES).every((s) => s.zh && s.phrase), '景别枚举带中文名与英文短语');
ok(Object.keys(CAMERA_MOVES).length >= 18, '运镜词表覆盖 H3 全部动作类型');
ok(CAMERA_MOVES['Static Shot'] === '固定' && CAMERA_MOVES['Push In'] === '推', '运镜词表中英对照');

/* ---------------- render markdown ---------------- */

const md = renderMarkdown(FIXTURE, CTX);
ok(md.includes('# 渡口 · 分镜（第 1 集）'), 'md 标题');
ok(md.includes('### E01-01 · 渡口栈桥（浓雾清晨）'), 'md 段头带场景名与光照');
ok(md.includes('H3 视频提示词'), 'md 带逐段 H3 提示词');
ok(md.includes('How the reference pictures align'), '多分镜段的对齐指令完整可复制');
ok(md.includes('[Shot 2] At 00:03.000,'), '切点时刻原样进 md');
ok(md.includes('老周'), 'md 说话人显示名字');
eq((md.match(/\*\*Seedance 视频提示词\*\*/g) ?? []).length, 10, 'md 每段附 Seedance 提示词');
ok(md.includes(`> 走位：${FIXTURE.episodes[0].segments[0].blocking}`), 'md 每段带走位');
ok(md.includes('生成批次单') && md.includes('配音对齐单'), 'md 带两张工单');
ok(renderMarkdown(FIXTURE, { script: SCRIPT }).includes('C03'), '不给 outline 退回裸 ID');

/* ---------------- render html ---------------- */

const html = renderHtml(FIXTURE, CTX);
ok(html.includes('<!doctype html>'), 'html 完整文档');
ok(!/src="http|href="http|@import|url\(http/.test(html), '零外部资源');
ok(html.includes('分镜节奏带'), '01 分镜节奏带');
ok(html.includes('分集分镜表'), '02 分集分镜表');
ok(html.includes('生成批次单'), '03 生成批次单');
ok(html.includes('配音对齐单'), '04 配音对齐单');
ok(html.includes('✓ 质量门 18 / 18'), '页眉徽章全绿');
// 提示词面板：H3 与 Seedance 两个页签并列，默认 H3；复制键跟着当前页签（前端切换时改 data-copy）
eq((html.match(/<button class="ptab on" data-i="0">H3 提示词<\/button><button class="ptab" data-i="1">Seedance 提示词<\/button>/g) ?? []).length, 10, '每段都有 H3 / Seedance 两个页签');
eq((html.match(/<pre class="pp">@\[图片1\] = /g) ?? []).length, 10, '每段都有程序拼好的 Seedance 提示词');
ok(html.includes("panel.querySelector('.pp-h .copy').dataset.copy"), '切页签时复制键换成当前那一份');
ok(html.includes(`<p class="seg-block"><b>走位</b>${FIXTURE.episodes[0].segments[0].blocking}</p>`), '段卡显示走位');
ok(html.includes('<p class="scomp">35mm 广角，中景深 · 年轻女子 + 背后平视跟随 · 中心构图 · 视线 前方雾中 · 焦点 锁定年轻女子背影与怀中皮箱 · 微晃</p>'), '切行显示构图量化字段');
ok(html.includes('class="rseg"'), '节奏带按段分组（粗分隔）');
ok(html.includes(`href="#seg-${SEG01.id}"`), '节奏带段可跳转，锚点是段 id');
ok(html.includes(`<b>E01-01</b><span class="sid">${SEG01.id}</span>`), '段卡显示段标签，并附段 id');
ok(html.includes('主分镜图 · #1 未生成'), '主分镜图缺图时显示占位不装有');
ok(html.includes('#2 未生成'), '子分镜图缺图有小占位');
// 主分镜图区：无图时每切各占一整行提示词卡 + 复制按钮（PR 核心目标）
{
  const nCuts = FIXTURE.episodes.reduce((n, e) => n + e.segments.reduce((m, s) => m + s.cuts.length, 0), 0);
  ok((html.match(/class="frame ph fcell"/g) ?? []).length === nCuts, '无图时每切都是整宽提示词卡');
  const c0 = FIXTURE.episodes[0].segments[0].cuts;
  ok(html.includes(`data-copy="${c0[0].frame}"`), '主分镜格复制按钮带该切 frame 原文');
  ok(html.includes(`data-copy="${c0[1].frame}"`), '子分镜格复制按钮同样带 frame 原文');
}
ok(html.includes('class="shots clip"'), '段卡区默认截断');
ok(html.includes('展开全部段'), '每集自带展开按钮');
ok(html.includes('H3 提示词'), '段卡带 H3 提示词面板');
ok(html.includes('class="duo"'), '分镜列表与提示词面板五五分栏');
ok(html.includes('static shot'), '英文提示词正文进面板');
ok(html.includes('integrated_multimodal_description'), '官方骨架字段进面板');
ok(html.includes('[Shot 2] At'), '逐镜换行的结构化正文进面板');
ok(html.includes('分镜图提示词'), '每个分镜带分镜图提示词复制按钮');
ok(html.includes('id="lightbox"'), '点图放大');
ok(html.includes('渡口-storyboard.json'), '导出文件名');
ok(html.includes('批次 01'), '批次卡编号');
ok(html.includes('@media print'), '打印样式');
ok(html.includes('老周'), 'html 里 ID 换成名字');
{
  const withImg = renderHtml(FIXTURE, { ...CTX, image: (kind, rel) => rel });
  ok(withImg.includes(`"${SEG01.id}/${SEG01.cuts[0].id}.png"`), '主分镜图从段 id 文件夹按切 id 读');
  ok(withImg.includes(`"${SEG01.id}/${SEG01.cuts[1].id}.png"`), '子分镜图同样按切 id 读');
  ok(!withImg.includes('未生成'), '有图时不再显示占位');
  ok(!withImg.includes('class="frame ph fcell"'), '图出全时不再走整宽提示词卡');
  ok(withImg.includes('class="subs"'), '图出全时保留子分镜条');
  ok(withImg.includes('class="subf"'), '子分镜条用小缩略图');
}
// 分镜图位跟着正式画幅走；旧 _meta 和 frame 尾缀只保留为兼容路径
{
  const styleOf = (h) => h.match(/<style>[\s\S]*?<\/style>/)[0];
  ok(html.includes('.frame{width:100%;aspect-ratio:16/9;') && !html.includes('aspect-ratio:9/16'), '默认横屏：分镜图位 16:9，不插竖屏样式');
  const defaulted = clone(FIXTURE);
  delete defaulted.aspectRatio;
  ok(styleOf(renderHtml(defaulted, CTX)) === styleOf(html), '省略正式画幅时默认 16:9，样式逐字节不变');
  const port = clone(FIXTURE);
  port.aspectRatio = '9:16';
  const ph = renderHtml(port, { ...CTX, image: (kind, rel) => rel });
  ok(ph.includes('.frame,.subf{aspect-ratio:9/16}'), 'aspectRatio=9:16：主图与子分镜条图位改 9:16');
  ok(ph.includes('img.frame{width:min(100%,300px)'), '竖屏主图收窄，不撑成一屏多高');
  ok(ph.includes('.bimg{width:100%;aspect-ratio:16/9;'), '场景设定图仍是 16:9，不跟剧的画幅走');
  port._meta = { orientation: 'landscape' };
  ok(renderHtml(port, CTX).includes('aspect-ratio:9/16'), '正式 aspectRatio 比旧 _meta.orientation 优先');
  const legacy = clone(FIXTURE);
  delete legacy.aspectRatio;
  legacy._meta = { orientation: 'V' };
  ok(renderHtml(legacy, CTX).includes('aspect-ratio:9/16'), '旧 _meta.orientation 的简写 v 仍兼容为竖屏');
  // 样例的 frame 本身不带画幅标签（画幅由下游定），这里照下游应用的写法在末尾贴 `, 9:16`
  const tail = clone(FIXTURE);
  delete tail.aspectRatio;
  for (const ep of tail.episodes) for (const s of ep.segments) for (const c of s.cuts) c.frame = `${c.frame ?? ''}, 9:16`;
  ok(renderHtml(tail, CTX).includes('aspect-ratio:9/16'), '没记 _meta 时按 frame 末尾的 9:16 标签认竖屏');
  tail._meta = { orientation: 'landscape' };
  ok(!renderHtml(tail, CTX).includes('aspect-ratio:9/16'), '_meta.orientation 比 frame 标签优先');
}
// 病灶横幅
{
  const doc = clone(FIXTURE);
  doc.episodes[0].segments[0].cuts[0].seconds = 6;
  const h = renderHtml(doc, CTX);
  ok(h.includes('class="galert"'), '有门未过时页顶挂病灶横幅');
  ok(h.includes('gatepill fail'), '徽章翻红');
}
// XSS：模型数据全部过 esc
{
  const doc = clone(FIXTURE);
  doc.source = '<script>alert(1)</script>';
  doc.episodes[0].segments[0].note = '<img src=x onerror=alert(1)>';
  const h = renderHtml(doc, { script: SCRIPT });
  ok(!h.includes('<script>alert(1)</script>'), '标题被转义');
  ok(!h.includes('<img src=x'), 'note 被转义');
  ok(h.includes('\\u003c'), '内嵌 JSON 的 < 转成 \\u003c，防 </script 截断');
}

/* ---------------- 报告界面语言（--lang，与 promptLang 独立） ---------------- */

{
  const en = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(en.includes('<html lang="en">'), 'en 报告的 html lang 属性跟着语言走');
  ok(en.includes('Export JSON'), 'en 界面：导出按钮英文');
  ok(en.includes('Quality gates 18 / 18'), 'en 界面：页眉徽章英文');
  ok(en.includes('>Seedance prompt</button>') && en.includes('<b>Blocking</b>') && en.includes('· slight shake</p>'), 'en 界面：页签、走位、稳定性都有英文标签');
  ok(en.includes('Cut rhythm strip'), 'en 界面：节奏带节标题英文');
  ok(en.includes('Segment cards'), 'en 界面：分镜表节标题英文');
  ok(en.includes('Generation batches'), 'en 界面：批次节标题英文');
  ok(en.includes('Audio alignment'), 'en 界面：配音对齐节标题英文');
  ok(en.includes('master frame'), 'en 界面：主分镜图占位标签英文');
  ok(!en.includes('导出 JSON'), 'en 界面不残留中文导出按钮');
  ok(!en.includes('生成批次单'), 'en 界面不残留中文批次标题');
  ok(!en.includes('配音对齐单'), 'en 界面不残留中文对齐标题');
  ok(en.includes('How the reference pictures align'), 'en 界面下 H3 提示词数据原样不动');
  ok(en.includes('[Shot 2] At 00:03.000,'), 'en 界面下切点时刻数据原样不动');
}
{
  const enMd = renderMarkdown(FIXTURE, { ...CTX, lang: 'en' });
  ok(enMd.includes('# 渡口 · Storyboard (Episode 1)') && enMd.includes('Audio alignment'), 'en markdown 标题与节标题英文');
}
{
  const zhAgain = renderHtml(FIXTURE, CTX);
  ok(zhAgain.includes('<html lang="zh">') && zhAgain.includes('导出 JSON'), '默认仍是中文界面');
}
{
  const doc = clone(FIXTURE);
  doc.lang = 'en';
  ok(renderHtml(doc, CTX).includes('Export JSON'), 'JSON 顶层 lang 字段可选定界面语言');
  ok(renderHtml(doc, { ...CTX, lang: 'zh' }).includes('导出 JSON'), 'ctx.lang（--lang）优先于 JSON 的 lang 字段');
}
{
  let threw = false;
  try {
    renderHtml(FIXTURE, { ...CTX, lang: 'ja' });
  } catch (e) {
    threw = /zh \/ en/.test(e.message);
  }
  ok(threw, '非法界面语言抛错并点名内置 zh / en');
}

// 质量门面板是报告的一部分：英文界面下门标签也要翻译（阈值由门自己算，原样保留）
{
  const gateEn = renderHtml(FIXTURE, { ...CTX, lang: 'en' });
  ok(gateEn.includes('Every cut 2–5s'), 'EN 报告的质量门标签翻译且阈值原样保留');
  ok(!gateEn.includes('每个分镜 2–5 秒'), 'EN 报告不再出现中文门标签');
  ok(gateEn.includes('no recipe card library mounted'), 'EN 报告的跳过说明也翻译');
}

/* ---------------- 报告里的「配方」列（偏离只提示，不设门） ---------------- */

{
  const doc = withRecipe();
  const rmd = renderMarkdown(doc, SHOTS);
  ok(rmd.includes('| 配方 |'), 'md 分镜表有配方列');
  ok(rmd.includes('| 过肩正反打 |'), 'md 显示卡名，没偏离就不带 ≠');
  ok(renderMarkdown(doc, { ...SHOTS, lang: 'en' }).includes('| Recipe |'), 'en md 的配方列表头英文');
  const rhtml = renderHtml(doc, SHOTS);
  ok(rhtml.includes('class="cut-rc">过肩正反打</span>'), 'html 分镜行有配方标签');
  ok(!rhtml.includes('≠'), '没偏离就不出 ≠ 上标');
}
{
  const doc = withRecipe();
  segAt(doc, 'E01-05').cuts[0].size = 'extreme-wide';
  const rhtml = renderHtml(doc, SHOTS);
  ok(rhtml.includes('<sup title="配方建议景别 medium / close——只提示不设门">≠</sup>'), '偏离加 ≠ 上标，建议值写进 title');
  ok(renderMarkdown(doc, SHOTS).includes('过肩正反打 ≠（配方建议景别 medium / close——只提示不设门）'), 'md 没有 title，建议值直接写进格子');
  ok(renderHtml(doc, { ...SHOTS, lang: 'en' }).includes('Recipe suggests size medium / close — advisory, not gated'), 'en 报告的偏离提示英文');
  ok(gate(doc, 'shot-recipe', SHOTS).ok, '偏离在报告里提示，但门照过——门的信用比数量重要');
}
{
  const doc = withRecipe();
  ok(renderMarkdown(doc, CTX).includes('| ots-shot-reverse |'), '不挂卡库时配方列退回裸 id');
  ok(renderMarkdown(FIXTURE, CTX).includes('| — |'), '没引用配方的切在配方列写 —');
}

/* ---------------- 稳定 id：补 id、2.x 迁移、CLI ---------------- */

{
  const raw = clone(FIXTURE);
  delete raw.episodes[0].id;
  delete segAt(raw, 'E01-03').id;
  delete segAt(raw, 'E01-03').cuts[1].id;
  const before = JSON.stringify(raw);
  const a = assignStoryboardIds(raw, { script: SCRIPT, rng: seededRng('t') });
  eq(JSON.stringify(raw), before, 'assignStoryboardIds 不改入参');
  eq(a.episodes[0].id, SCRIPT.episodes[0].id, '集 id 按集号从剧本照抄');
  ok(isId(segAt(a, 'E01-03').id, 'sg') && isId(segAt(a, 'E01-03').cuts[1].id, 'ct'), '补上段 id 与切 id');
  eq(segAt(a, 'E01-02').id, segAt(FIXTURE, 'E01-02').id, '已有的段 id 不动');
  eq(segAt(a, 'E01-03').cuts[0].id, segAt(FIXTURE, 'E01-03').cuts[0].id, '已有的切 id 不动');
  eq(JSON.stringify(assignStoryboardIds(raw, { script: SCRIPT, rng: seededRng('t') })), JSON.stringify(a), '同一种子可复现');
  eq(assignStoryboardIds(raw, { rng: seededRng('t') }).episodes[0].id, undefined, '不给剧本不补集 id——集 id 只能来自剧本');
  ok(gate(a, 'ids').ok, '补完过 id 门');
}

/** 把 3.0 样例退回 2.x 写法：段号按位置、sceneIndex、beats 区间，键顺序与 2.x 一致。 */
const toV2 = (doc) => ({
  ...doc,
  episodes: doc.episodes.map(({ id: epId, ...ep }) => {
    const scenes = SCRIPT.episodes.find((e) => e.id === epId).scenes;
    return {
      ...ep,
      segments: ep.segments.map(({ id, sceneRef, ...seg }, i) => {
        const si = scenes.findIndex((s) => s.id === sceneRef);
        const flow = scenes[si].flow.map((b) => b.id);
        const cuts = seg.cuts.map(({ id: cutId, beatIds, ...cut }) => ({
          beats: [flow.indexOf(beatIds[0]) + 1, flow.indexOf(beatIds[beatIds.length - 1]) + 1],
          ...cut,
        }));
        return { id: segLabel(ep.ep, i), sceneIndex: si + 1, ...seg, cuts };
      }),
    };
  }),
});
const V2 = toV2(FIXTURE);
{
  ok(V2.episodes[0].segments[3].id === 'E01-04' && V2.episodes[0].segments[3].sceneIndex === 2, '2.x 写法还原出来（段号、sceneIndex）');
  const before = JSON.stringify(V2);
  const m = migrateStoryboard(V2, SCRIPT, seededRng('渡口-storyboard'));
  eq(JSON.stringify(V2), before, 'migrateStoryboard 不改入参');
  eq(JSON.stringify(m), JSON.stringify(FIXTURE), '迁移结果与 3.0 样例一致');
  eq(JSON.stringify(migrateStoryboard(FIXTURE, SCRIPT)), JSON.stringify(FIXTURE), '已经是 3.0 的文件再迁移一次原样不变');
  const msgOf = (fn) => {
    try { fn(); return ''; } catch (e) { return e.message; }
  };
  const bad = clone(V2);
  bad.episodes[0].segments[2].sceneIndex = 9;
  ok(msgOf(() => migrateStoryboard(bad, SCRIPT)).includes('E01-03 的 sceneIndex 9 在剧本第 1 集里找不到'), 'sceneIndex 越界时点名');
  const bad2 = clone(V2);
  bad2.episodes[0].segments[2].cuts[1].beats = [1, 99];
  ok(msgOf(() => migrateStoryboard(bad2, SCRIPT)).includes('E01-03#2 的 beats [1, 99] 超出该场 13 拍'), 'beats 越界时点名');
  ok(msgOf(() => migrateStoryboard(V2, null)).includes('--script'), '迁移必须给剧本');
  const old = clone(SCRIPT);
  delete old.episodes[0].scenes[0].id;
  ok(msgOf(() => migrateStoryboard(V2, old)).includes('ids --write'), '剧本还没补 id 时迁移拒绝');
  const bad3 = clone(V2);
  bad3.episodes[0].segments[2].cuts[1].beats = [3, 1];
  ok(msgOf(() => migrateStoryboard(bad3, SCRIPT)).includes('E01-03#2 的 beats [3, 1] 超出该场'), 'beats 反向区间时点名');
}

const errOf = (fn) => {
  try { fn(); return ''; } catch (e) { return e.message; }
};
{
  // 切到一半的 2.x 草稿：seedScenes 底稿按 3.0 剧本重新生成
  const draft = clone(V2);
  draft.episodes[0].seedScenes = [{ sceneIndex: 1, beats: [{ n: 1 }] }];
  const m = migrateStoryboard(draft, SCRIPT, seededRng('渡口-storyboard'));
  eq(JSON.stringify(m.episodes[0].seedScenes), JSON.stringify(seedFromScript(SCRIPT).episodes[0].seedScenes), '2.x 的 seedScenes 换成 3.0 底稿');
  eq(JSON.stringify(migrateStoryboard(m, SCRIPT)), JSON.stringify(m), '带 3.0 底稿再迁移一次原样不变');
  ok(!('seedScenes' in migrateStoryboard(V2, SCRIPT).episodes[0]), '没有底稿的集不凭空加底稿');
}
{
  // 多集都缺集 id：每集按自己的集号抄到对应的集 id
  const doc = clone(FIXTURE);
  doc.episodes.push({ ep: 2, segments: [] });
  delete doc.episodes[0].id;
  const a = assignStoryboardIds(doc, { script: SCRIPT, rng: seededRng('t') });
  eq(a.episodes.map((e) => e.id).join(','), `${SCRIPT.episodes[0].id},${SCRIPT.episodes[1].id}`, '多集各自抄到对应的集 id');
}
{
  // 补 id 时新 id 计入已用集合：随机源连出两次同样的值，第二切必须重抽
  const doc = clone(FIXTURE);
  delete segAt(doc, 'E01-01').cuts[0].id;
  delete segAt(doc, 'E01-02').cuts[0].id;
  let n = 0;
  const repeating = () => (n++ < 16 ? 0 : 1);
  const a = assignStoryboardIds(doc, { script: SCRIPT, rng: repeating });
  const [x, y] = [segAt(a, 'E01-01').cuts[0].id, segAt(a, 'E01-02').cuts[0].id];
  ok(isId(x, 'ct') && isId(y, 'ct') && x !== y, '跨段补的切 id 不撞号');
}
{
  // 大纲插集后剧本 renumber 过：分镜按集 id 刷新集号，标签跟着变
  const script = clone(SCRIPT);
  script.episodes = script.episodes.map((e) => ({ ...e, ep: e.ep + 1 }));
  const ctx = { ...CTX, script };
  ok(!gate(FIXTURE, 'ids', ctx).ok && gate(FIXTURE, 'ids', ctx).detail.includes('在剧本里是第 2 集'), '剧本集号变了，ids 门点名');
  const before = JSON.stringify(FIXTURE);
  const re = renumberStoryboard(FIXTURE, script);
  eq(JSON.stringify(FIXTURE), before, 'renumberStoryboard 不改入参');
  eq(re.episodes[0].ep, 2, '集号改成剧本里的集号');
  eq(segAt(re, 'E02-01').id, SEG01.id, '标签跟着变成 E02-01，段 id 不动');
  ok(gate(re, 'ids', ctx).ok, 'renumber 后 ids 门通过');
  const orphan = clone(FIXTURE); orphan.episodes[0].id = 'ep_zzzzzzzz';
  eq(renumberStoryboard(orphan, script).episodes[0].ep, 1, '集 id 不在剧本里的集原样保留');
}
{
  // 剧本里 id 重复：按 id 查会认到后一个，分镜的 ids 门自己也要拦
  const script = clone(SCRIPT);
  script.episodes[0].scenes[1].flow[0].id = script.episodes[0].scenes[0].flow[0].id;
  ok(gate(FIXTURE, 'ids', { ...CTX, script }).detail.includes(`剧本里节拍 id ${S1[0]} 重复`), '剧本节拍 id 重复被点名');
  const script2 = clone(SCRIPT);
  script2.episodes[1].scenes[0].id = script2.episodes[0].scenes[0].id;
  ok(gate(FIXTURE, 'ids', { ...CTX, script: script2 }).detail.includes('剧本里场次 id'), '剧本场次 id 重复被点名');
}
{
  // 导出前查 id：段 id、切 id 拼进文件路径，格式不对就不许落盘
  const evil = clone(FIXTURE);
  segAt(evil, 'E01-01').id = '../../pwn';
  ok(errOf(() => exportPack(evil, SCRIPT)).includes('导出前 id 要先过 ids 门'), 'exportPack 拒绝格式不对的段 id');
  const evil2 = clone(FIXTURE);
  segAt(evil2, 'E01-01').cuts[0].id = '../x';
  ok(errOf(() => exportPack(evil2, SCRIPT)).includes('切 id「../x」格式不对'), 'exportPack 拒绝格式不对的切 id');
}
{
  // export CLI：落盘、--frames 拷图、--out、--images、参数报错
  const BOARD = join(here, 'novel-storyboard.mjs');
  const SCRIPT_PATH = join(here, '../references/test-fixtures/upstream/渡口-script.json');
  const SAMPLE_PATH = join(here, '../examples/渡口-storyboard.json');
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-export-'));
  const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', cwd: dir });
  for (const c of SEG01.cuts) {
    mkdirSync(join(dir, 'frames', SEG01.id), { recursive: true });
    writeFileSync(join(dir, 'frames', SEG01.id, `${c.id}.png`), 'png');
  }
  const out = run('export', SAMPLE_PATH, '--script', SCRIPT_PATH, '--out', 'h3', '--frames', 'frames');
  eq(out.status, 0, 'CLI export 正常退出');
  ok(SEG01.cuts.every((c) => existsSync(join(dir, 'h3', SEG01.id, `${c.id}.png`))), '--frames 的分镜图按 <段 id>/<切 id>.png 拷进 --out');
  ok(existsSync(join(dir, 'h3', SEG01.id, 'prompt.md')), '每段的 prompt.md 落盘');
  const manifest = JSON.parse(readFileSync(join(dir, 'h3', 'manifest.json'), 'utf8'));
  eq(manifest.find((m) => m.segment === SEG01.id).missing.length, 0, '拷进来的图不再标缺');
  ok(manifest.find((m) => m.segment === segAt(FIXTURE, 'E01-02').id).missing.length > 0, '没给图的段照样标缺');
  ok(out.stdout.includes(`拷入 ${SEG01.cuts.length} 张分镜图`), '报告拷了多少张图');

  mkdirSync(join(dir, 'imgs'));
  writeFileSync(join(dir, 'imgs', '沈知微-sheet.png'), 'png');
  const OUTLINE_PATH = join(here, '../references/test-fixtures/upstream/渡口-outline.json');
  eq(run('export', SAMPLE_PATH, '--script', SCRIPT_PATH, '--outline', OUTLINE_PATH, '--protocol', 'seedance', '--out', 'sd', '--images', 'imgs').status, 0, 'CLI export seedance 正常退出');
  ok(existsSync(join(dir, 'sd', SEG06.id, 'ref-2.png')), '--images 的设定图拷进 Seedance 包');
  ok(existsSync(join(dir, 'sd', 'seedance-manifest.json')), 'Seedance 包带 seedance-manifest.json');

  // 段 id 写成「../frames/<段 id>」：拷图的源文件真的存在，不查 id 就会拷到 --out 外面
  const evil = clone(FIXTURE);
  segAt(evil, 'E01-01').id = `../frames/${SEG01.id}`;
  writeFileSync(join(dir, 'evil.json'), JSON.stringify(evil));
  const bad = run('export', 'evil.json', '--script', SCRIPT_PATH, '--out', 'a/b/out', '--frames', 'frames');
  eq(bad.status, 1, 'CLI export 遇到格式不对的段 id 退出 1');
  ok(bad.stderr.includes('导出前 id 要先过 ids 门'), 'CLI export 报错说明要先过 ids 门');
  ok(!existsSync(join(dir, 'a')), '格式不对的 id 一个文件都不写');
  eq(run('export', SAMPLE_PATH, '--script', SCRIPT_PATH, '--protocol', 'mp4').status, 1, 'CLI export 拒绝未知的 --protocol');
  eq(run('export', SAMPLE_PATH).status, 1, 'CLI export 缺 --script 报错');
  rmSync(dir, { recursive: true, force: true });
}
{
  const BOARD = join(here, 'novel-storyboard.mjs');
  const SCRIPT_PATH = join(here, '../references/test-fixtures/upstream/渡口-script.json');
  const SAMPLE = readFileSync(join(here, '../examples/渡口-storyboard.json'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-ids-'));
  const file = join(dir, 'storyboard.json');
  const run = (...args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8' });

  writeFileSync(file, JSON.stringify(V2, null, 2) + '\n');
  eq(run('migrate', file).status, 1, 'CLI migrate 缺 --script 报错');
  eq(JSON.parse(run('migrate', file, '--script', SCRIPT_PATH, '--seed', '渡口-storyboard').stdout).episodes[0].segments[0].id, SEG01.id, 'CLI migrate 打印迁移结果');
  eq(run('migrate', file, '--script', SCRIPT_PATH, '--seed', '渡口-storyboard', '--write').status, 0, 'CLI migrate --write 正常退出');
  eq(readFileSync(file, 'utf8'), SAMPLE, '写回的文件与样例逐字节相同');

  const raw = clone(FIXTURE);
  delete segAt(raw, 'E01-02').id;
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  const printed = run('ids', file, '--script', SCRIPT_PATH, '--seed', 'cli');
  eq(printed.status, 0, 'CLI ids 正常退出');
  ok(isId(segAt(JSON.parse(printed.stdout), 'E01-02').id, 'sg'), 'CLI ids 打印补好 id 的 JSON');
  eq(run('ids', file, '--seed', 'cli', '--write').status, 0, 'CLI ids --write 正常退出');
  const once = readFileSync(file, 'utf8');
  run('ids', file, '--write');
  eq(readFileSync(file, 'utf8'), once, 'CLI ids 幂等');

  // 不带 --seed 走加密随机：两次补出的 id 不能撞
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  const fresh = () => segAt(JSON.parse(run('ids', file).stdout), 'E01-02').id;
  const [x, y] = [fresh(), fresh()];
  ok(isId(x, 'sg') && isId(y, 'sg') && x !== y, 'CLI ids 不带 --seed 两次补出的 id 互不相同');

  writeFileSync(file, SAMPLE);
  eq(run('renumber', file).status, 1, 'CLI renumber 缺 --script 报错');
  eq(run('renumber', file, '--script', SCRIPT_PATH, '--write').status, 0, 'CLI renumber --write 正常退出');
  eq(readFileSync(file, 'utf8'), SAMPLE, '集号本来就对时 renumber 不改文件');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`✓ ${passed} 项自测全部通过`);

#!/usr/bin/env node
// 自测：覆盖 novel-staging.mjs 里所有确定性逻辑。
// 不调用任何模型，不花额度，跑一次 < 1 秒。
//   node scripts/selftest.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isId } from './ids.mjs';
import {
  migrateStaging,
  renumberStaging,
  ITEM_RANGE,
  MIN_APART,
  blockingLines,
  defaultFacing,
  gateReport,
  moveTo,
  nearestPlace,
  parseEps,
  placePoint,
  placePoints,
  placeSentence,
  renderHtml,
  renderMarkdown,
  sceneProblems,
  seedFromScript,
  slug,
  stagingBlocking,
  stagingCore,
  validateStaging,
} from './novel-staging.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, '..', ...p), 'utf8'));
const FIXTURE = read('examples', '渡口-staging.json');
const SCRIPT = read('references', 'test-fixtures', 'upstream', '渡口-script.json');
const ART = read('references', 'test-fixtures', 'upstream', '渡口-art.json');
const OUTLINE = read('references', 'test-fixtures', 'upstream', '渡口-outline.json');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, `${msg} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  passed++;
}
const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const gate = (d, id, opts = {}) => gateReport(d, opts).find((g) => g.id === id);
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* ---------------- 平面几何 ---------------- */

const TABLE = { name: '长餐桌', alt: 'long table', plan: [0.3, 0.3, 0.7, 0.6], on: false };
const CHAIR = { name: '主位太师椅', alt: 'armchair', plan: [0.45, 0.1, 0.55, 0.2], on: true };
const ROUND = { name: '红木圆桌', alt: 'round table', plan: [0.3, 0.3, 0.7, 0.7], on: false };
{
  const n = placePoint(TABLE, 'north', 0);
  ok(near(n.x, 0.3) && near(n.y, 0.26), '北侧 along 0 在桌子西北角外一点');
  const e = placePoint(TABLE, 'east', 1);
  ok(near(e.x, 0.74) && near(e.y, 0.6), '东侧 along 1 在东南角外一点（东西两侧沿南北排）');
  const s = placePoint(TABLE, 'south', 0.5);
  ok(near(s.x, 0.5) && near(s.y, 0.64), '南侧中段在南边正中外一点');
  const on = placePoint(CHAIR, 'on', 0.3);
  ok(near(on.x, 0.5) && near(on.y, 0.15), '在东西上面：放在它中间，along 不起作用');
  const r = placePoint(ROUND, 'south', 0.5);
  ok(near(r.x, 0.5) && r.y > 0.7, '圆的东西：南侧中段在圆周正下方外面');
  const edge = placePoint({ name: '贴墙柜', plan: [0, 0, 0.1, 0.1], on: false }, 'west', 0.5);
  ok(edge.x === 0, '平面外的点收回到 0–1 里面');
}
{
  const pts = placePoints([
    { id: 'A', present: true, item: '主位太师椅', side: 'on', along: 0.5 },
    { id: 'B', present: true, item: '主位太师椅', side: 'on', along: 0.5 },
    { id: 'C', present: false, item: null },
    { id: 'D', present: true, item: '不存在的东西', side: 'north', along: 0.5 },
  ], [TABLE, CHAIR]);
  ok(pts.has('A') && pts.has('B') && !pts.has('C') && !pts.has('D'), '只给在场、东西认得出来的人算点');
  ok(pts.get('A').x !== pts.get('B').x, '两个人在同一件东西上并排，不叠在一点');
}
{
  eq(nearestPlace({ x: 0.5, y: 0.15 }, [TABLE, CHAIR]), { item: '主位太师椅', side: 'on', along: 0.5 }, '松在能坐的东西里面：坐在它上面');
  const t = nearestPlace({ x: 0.75, y: 0.36 }, [TABLE, CHAIR]);
  ok(t.item === '长餐桌' && t.side === 'east' && near(t.along, 0.2), '松在桌子东边：东侧，沿南北量出 along');
  const inside = nearestPlace({ x: 0.5, y: 0.32 }, [TABLE]);
  ok(inside.item === '长餐桌' && inside.side === 'north', '松在桌面上：落到最近的那条边');
  const r = nearestPlace({ x: 0.5, y: 0.8 }, [ROUND]);
  ok(r.item === '红木圆桌' && r.side === 'south' && Math.abs(r.along - 0.5) < 0.01, '圆桌正下方：南侧中段');
  eq(nearestPlace({ x: 0.5, y: 0.5 }, []), null, '没有东西就没有落点');
}
{
  eq(defaultFacing('east', TABLE), 'west', '在东侧面朝西');
  eq(defaultFacing('north', TABLE), 'south', '在北侧面朝南');
  eq(defaultFacing('on', { plan: [0, 0.4, 0.1, 0.6] }), 'east', '在靠西墙的东西上面：面朝东（房间）');
  eq(defaultFacing('on', CHAIR), 'south', '在中间的东西上面：面朝南');
}
{
  const absent = { id: 'C01', name: '江小白', present: false, item: null, side: null, along: null, posture: null, facing: null };
  const m = moveTo(absent, { item: '长餐桌', side: 'east', along: 0.333 }, [TABLE]);
  ok(m.present && m.posture === 'stand' && m.facing === 'west' && m.along === 0.33, '从托盘拖进来：在场、站着、面朝那件东西，along 取两位');
  const sat = moveTo(m, { item: '主位太师椅', side: 'on', along: 0.5 }, [TABLE, CHAIR]);
  ok(sat.posture === 'sit' && sat.along === 0.5, '拖到能坐的东西上：坐下');
  const turned = { ...m, facing: 'north' };
  eq(moveTo(turned, { item: '长餐桌', side: 'east', along: 0.8 }, [TABLE]).facing, 'north', '同一侧挪一挪：朝向照旧');
  eq(moveTo(turned, { item: '长餐桌', side: 'west', along: 0.8 }, [TABLE]).facing, 'east', '换了一侧：转过去面朝它');
}

/* ---------------- 走位句 ---------------- */

{
  const p = { id: 'C04', name: '胡二爷', present: true, item: '第三排坐板', side: 'on', along: 0.5, posture: 'sit', facing: 'north' };
  eq(placeSentence(p, 'zh'), '胡二爷坐在第三排坐板上，面朝北', '在东西上面的说法');
  eq(placeSentence(p, 'en', undefined, 'third bench row'), '胡二爷 sits on the third bench row, facing north', '英文说法用另一种语言的名字');
  eq(placeSentence({ ...p, present: false }, 'zh'), null, '不在场的人没有句子');
  const a = { id: 'A', name: '萧海龙', present: true, item: '长餐桌', side: 'east', along: 0.1, posture: 'sit', facing: 'west' };
  const b = { id: 'B', name: '萧初然', present: true, item: '长餐桌', side: 'east', along: 0.2, posture: 'sit', facing: 'west' };
  const s = stagingBlocking({ places: [a, b], extras: 0, extrasWhere: null }, 'zh');
  ok(s.startsWith('萧海龙坐在长餐桌东侧靠北，面朝西；萧初然坐在长餐桌东侧靠北、萧海龙南侧，面朝西'), '同一侧落在同一段：说清谁挨着谁');
  ok(s.endsWith('其余座位空着，没有其他人。'), '没有群演：明说没有别人');
  ok(stagingBlocking({ places: [a], extras: 3, extrasWhere: '长桌西侧南端' }, 'zh').includes('另有 3 名群演在长桌西侧南端，只作背景'), '有群演：几个、在哪');
  eq(stagingBlocking({ places: [{ ...a, present: false, item: null }], extras: 0 }, 'zh'), null, '开场没人在场：没有走位句');
}
{
  const lines = blockingLines(FIXTURE, 'en');
  ok(lines[0].blocking.includes('earth bank at the shore'), '英文走位句用认图时写的 alt');
  eq(lines.length, FIXTURE.scenes.length, '每一场一句');
}

/* ---------------- seed ---------------- */

{
  const d = seedFromScript(SCRIPT, { art: ART, outline: OUTLINE });
  eq(d.locations.map((l) => l.sceneId), ['S02', 'S01', 'S03'], '地点按第一次出现的顺序');
  eq(d.locations[0].name, '渡口栈桥', '给了 art.json 地点带名字');
  eq(d.scenes.length, 9, '九场');
  ok(d.scenes.every((s) => isId(s.sceneRef, 'sc')), '每场照抄剧本的场次 id');
  eq(d.scenes[1].sceneRef, SCRIPT.episodes[0].scenes[1].id, 'sceneRef 指向剧本里对应的那一场');
  eq(Object.keys(d.scenes[0]).slice(0, 3), ['ep', 'scene', 'sceneRef'], 'sceneRef 紧跟在显示编号后面');
  {
    const noIds = JSON.parse(JSON.stringify(SCRIPT));
    delete noIds.episodes[0].scenes[0].id;
    let msg = '';
    try { seedFromScript(noIds); } catch (e) { msg = e.message; }
    ok(msg.includes('ids --write'), '剧本缺场次 id 时 seed 拒绝，并提示先补 id');
  }
  eq(d.scenes[1].cast.map((c) => c.name), ['沈知微', '陆行远', '老周', '胡二爷'], '给了 outline.json 人物带名字');
  ok(d.scenes.every((s) => s.places.length === s.cast.length && s.places.every((p) => p.present === null)), '每个出场人物一条，在不在场留给模型定');
  eq(d.scenes[0].lighting, '浓雾清晨', '剧本的光照时段搬过来');
  eq(seedFromScript(SCRIPT).scenes[0].cast[0].name, 'C01', '没给 outline.json：先用编号');
  eq(seedFromScript(SCRIPT, { eps: parseEps('5-6') }).scenes.map((s) => s.ep), [5, 5, 6, 6], '--eps 只取这几集');
  eq([...parseEps('1,3-4')], [1, 3, 4], '集号写法：逗号和连字符');
  const fresh = seedFromScript(SCRIPT, { art: ART, outline: OUTLINE });
  ok(!gate(fresh, 'items-read').ok && !gate(fresh, 'present-set').ok && !gate(fresh, 'extras').ok, '骨架本身过不了门：认图、在不在场、群演都还没定');
}

/* ---------------- 质量门 ---------------- */

{
  const opts = { script: SCRIPT, art: ART };
  const gates = gateReport(FIXTURE, opts);
  eq(gates.length, 9, '九道门');
  eq(gates[0].id, 'ids', 'id 门排第一道');
  ok(gates.every((g) => g.ok), '自带样例全部通过（对着样例剧本和美术）');
  eq(validateStaging(FIXTURE, opts), [], '样例没有违规');
  ok(gate(FIXTURE, 'cast-complete').detail.includes('未提供 script.json'), '没给剧本：明说没跟剧本核对');
}
{
  const d = clone();
  d.locations[0].items = [];
  ok(!gate(d, 'items-read').ok, '没认图：items-read 不过');
  const d2 = clone();
  d2.locations[2].items = d2.locations[2].items.slice(0, ITEM_RANGE[0] - 1);
  ok(!gate(d2, 'items-read').ok, `少于 ${ITEM_RANGE[0]} 件：items-read 不过`);
  const d3 = clone();
  d3.locations[0].readFrom = null;
  ok(!gate(d3, 'items-read').ok, '没写 readFrom：算没认图');
}
{
  const d = clone();
  d.locations[0].items[1].name = d.locations[0].items[0].name;
  ok(!gate(d, 'item-shape').ok, '名字重复：item-shape 不过');
  const d2 = clone();
  d2.locations[0].items[0].plan = [0.5, 0.2, 0.4, 0.3];
  ok(!gate(d2, 'item-shape').ok, 'plan 右小于左：item-shape 不过');
  const d3 = clone();
  d3.locations[0].readFrom = 'picture';
  ok(!gate(d3, 'item-shape').ok, '按图认的却没有 box：item-shape 不过');
  d3.locations[0].items.forEach((i) => { i.box = [0.1, 0.1, 0.2, 0.2]; });
  ok(gate(d3, 'item-shape').ok, '补上 box 就过');
  const d4 = clone();
  d4.locations[0].items[0].on = 'yes';
  ok(!gate(d4, 'item-shape').ok, 'on 不是布尔：item-shape 不过');
}
{
  const d = clone();
  d.scenes[0].sceneId = 'S09';
  ok(!gate(d, 'location-ref').ok, '这一场的地点没有认图结果：location-ref 不过');
  const art = JSON.parse(JSON.stringify(ART));
  art.scenes = art.scenes.filter((s) => s.id !== 'S03');
  ok(!gate(FIXTURE, 'location-ref', { art }).ok, '地点不在 art.json 里：location-ref 不过');
}
{
  const d = clone();
  d.scenes[1].places.pop();
  ok(!gate(d, 'cast-complete').ok, '少一个人：cast-complete 不过');
  const d2 = clone();
  d2.scenes[1].places.push({ ...d2.scenes[1].places[0], id: 'C09', name: '路人' });
  ok(!gate(d2, 'cast-complete').ok, '多一个出场人物表以外的人：cast-complete 不过');
  const d3 = clone();
  d3.scenes[1].places.push({ ...d3.scenes[1].places[1] });
  ok(!gate(d3, 'cast-complete').ok, '同一个人两条：cast-complete 不过');
  const script = JSON.parse(JSON.stringify(SCRIPT));
  script.episodes[0].scenes[0].characters.push('C02');
  ok(!gate(FIXTURE, 'cast-complete', { script }).ok, '出场人物跟剧本不一致：cast-complete 不过');
}
{
  const d = clone();
  d.scenes[2].places[0].present = null;
  ok(!gate(d, 'present-set').ok, '没定在不在场：present-set 不过');
  const d2 = clone();
  d2.scenes[2].places = d2.scenes[2].places.map((p) => ({ ...p, present: false, item: null, side: null, along: null }));
  ok(!gate(d2, 'present-set').ok, '开场一个人都不在：present-set 不过');
}
{
  const breakIt = (change) => {
    const d = clone();
    Object.assign(d.scenes[2].places[0], change);
    return gate(d, 'place-valid').ok;
  };
  ok(!breakIt({ item: '屏风' }), '站在认图里没有的东西旁：place-valid 不过');
  ok(!breakIt({ side: 'up' }), 'side 写错：place-valid 不过');
  ok(!breakIt({ item: '西侧舱壁', side: 'on' }), '写了在不能坐不能站的东西上：place-valid 不过');
  ok(!breakIt({ item: '西侧舱壁', side: 'east', along: 1.5 }), 'along 超出 0–1：place-valid 不过');
  ok(breakIt({ item: '西侧舱壁', side: 'east', along: 0.4, posture: 'stand', facing: 'east' }), '站在舱壁东侧：合法');
  ok(!breakIt({ posture: 'lie' }), 'posture 写错：place-valid 不过');
  ok(!breakIt({ facing: 'up' }), 'facing 写错：place-valid 不过');
  const d = clone();
  d.scenes[1].places[0].item = '第一排坐板';
  ok(!gate(d, 'place-valid').ok, '不在场的人写了 item：place-valid 不过');
}
{
  const d = clone();
  const [a, b] = d.scenes[2].places;
  Object.assign(a, { item: '西侧舱壁', side: 'east', along: 0.5, posture: 'stand', facing: 'east' });
  Object.assign(b, { item: '西侧舱壁', side: 'east', along: 0.5 + MIN_APART / 2, posture: 'stand', facing: 'east' });
  ok(!gate(d, 'no-overlap').ok, '同一侧挨得太近：no-overlap 不过');
  b.along = 0.5 + MIN_APART * 1.5;
  ok(gate(d, 'no-overlap').ok, '拉开就过');
  Object.assign(b, { item: '第一排坐板', side: 'on', along: 0.5 });
  Object.assign(a, { item: '第一排坐板', side: 'on', along: 0.5, posture: 'sit' });
  ok(gate(d, 'no-overlap').ok, '几个人坐在同一条坐板上不算叠：并排画开');
}
{
  const d = clone();
  d.scenes[0].extras = null;
  ok(!gate(d, 'extras').ok, '群演人数没写：extras 不过');
  const d2 = clone();
  d2.scenes[0].extras = 2;
  ok(!gate(d2, 'extras').ok, '有群演没写在哪：extras 不过');
  d2.scenes[0].extrasWhere = '岸端土坡西头';
  ok(gate(d2, 'extras').ok, '写了在哪就过');
  const d3 = clone();
  d3.scenes[0].extrasWhere = '岸端土坡';
  ok(!gate(d3, 'extras').ok, '没有群演却写了在哪：extras 不过');
}
{
  const d = clone();
  d.scenes[0].places[0].item = '屏风';
  const problems = validateStaging(d);
  ok(problems.length === 1 && problems[0].startsWith('第 1 集第 1 场：沈知微'), 'validate 每条带上场次和人');
  const live = sceneProblems(d.scenes[0], d.locations[0], 'en');
  ok(live[0].text.includes('is not one of the things'), '报告页面上的检查有英文说法');
}

/* ---------------- 报告 ---------------- */

{
  const md = renderMarkdown(FIXTURE);
  ok(md.startsWith('# 渡口 · 开场站位'), 'markdown 标题');
  ok(md.includes('沈知微站在岸端土坡上，面朝北；老周坐在靠岸的渡船上，面朝南'), 'markdown 带每场的走位句');
  ok(md.includes('开场不在：胡二爷'), 'markdown 写明谁开场不在');
  ok(renderMarkdown(FIXTURE, 'en').includes('Opening staging'), 'markdown 英文界面');
}
{
  const html = renderHtml(FIXTURE);
  ok(html.includes('id="staging-data"') && html.includes('function stagingCore()'), '报告带着数据和同一份算法');
  ok(html.includes('class="card scene"') && html.includes('class="room"'), '每场一张能拖的平面');
  ok(html.includes('导出 JSON') && html.includes('还原到文件里的版本'), '导出和还原按钮');
  ok(html.includes('✓ 质量门 9/9'), '页眉质量门徽章');
  const d = clone();
  d.scenes[0].places[0].name = '</script><b>x';
  const bad = renderHtml(d);
  ok(!bad.includes('</script><b>x'), '数据里的 </script 被转义，截不断脚本');
  ok(renderHtml(FIXTURE, 'en').includes('lang="en"') && renderHtml(FIXTURE, 'en').includes('Opening blocking'), '--lang en 出英文界面');
  let threw = false;
  try { renderHtml(FIXTURE, 'jp'); } catch { threw = true; }
  ok(threw, '非内置语言直接抛错（目前内置 zh / en）');
  const withPic = clone();
  withPic.locations[1].readFrom = 'picture';
  withPic.locations[1].items.forEach((i) => { i.box = [0.1, 0.2, 0.3, 0.4]; });
  const pic = renderHtml(withPic, 'zh', { S01: 'images/渡船船舱-sheet.png' });
  ok(pic.includes('src="images/渡船船舱-sheet.png"') && pic.includes('class="pbox"'), '有图就嵌图，认出来的东西在图上画框');
  ok(!renderHtml(FIXTURE).includes('class="pbox"'), '没图不画框，显示占位');
}
{
  // 页面里那份算法是 stagingCore 的源码原样嵌进去的：单独拿源码重建一份，结果必须一样
  const rebuilt = new Function(`${stagingCore.toString()}\nreturn stagingCore();`)();
  eq(rebuilt.nearestPlace({ x: 0.75, y: 0.36 }, [TABLE, CHAIR]), nearestPlace({ x: 0.75, y: 0.36 }, [TABLE, CHAIR]), '嵌进页面的算法不依赖外面的东西');
  eq(rebuilt.stagingBlocking(FIXTURE.scenes[3], 'zh'), stagingBlocking(FIXTURE.scenes[3], 'zh'), '页面上算出的走位句跟命令行一样');
}
{
  eq(slug('渡口 栈桥/东'), '渡口-栈桥-东', 'slug 去掉空白和斜杠');
  eq(slug('  '), 'scene', '空名字有兜底');
}

/* ---------------- CLI 默认交付格式 ---------------- */
{
  const cli = join(here, 'novel-staging.mjs');
  const fixture = join(here, '..', 'examples', '渡口-staging.json');
  const render = (...args) => spawnSync(process.execPath, [cli, 'render', fixture, ...args], { encoding: 'utf8' });
  const primary = render();
  ok(primary.status === 0 && /^<!doctype html>/i.test(primary.stdout), '不指定格式：默认输出 HTML 工具报告');
  const legacy = render('--html');
  ok(legacy.status === 0 && /^<!doctype html>/i.test(legacy.stdout), '显式 --html 继续输出 HTML');
  const text = render('--md');
  ok(text.status === 0 && text.stdout.startsWith('# 渡口 · 开场站位'), '显式 --md 才输出 Markdown');
  const english = render('--lang', 'en');
  ok(english.status === 0 && /<html lang="en">/.test(english.stdout), '默认 HTML 支持英文界面');
  const conflict = render('--html', '--md');
  ok(conflict.status !== 0 && conflict.stdout === '', '格式冲突时不输出混合产物');
}

/* ---------------- 稳定 id ---------------- */
// 场次的身份是 sceneRef（剧本的场次 id）；ep / scene 是显示缓存，给了剧本就对照。

{
  const opts = { script: SCRIPT, art: ART };
  ok(gate(FIXTURE, 'ids', opts).ok, '样例的 id 门通过');
  ok(FIXTURE.scenes.every((s) => isId(s.sceneRef, 'sc')), '样例每场都有 sceneRef');
  ok(gate(FIXTURE, 'ids').detail.includes('未提供 script.json'), '没给剧本：id 门明说只查了格式');

  const a = clone(); delete a.scenes[2].sceneRef;
  ok(!gate(a, 'ids').ok && gate(a, 'ids').detail.includes('第 2 集第 1 场 缺 sceneRef'), '缺 sceneRef 被拦并点名');
  const b = clone(); b.scenes[0].sceneRef = 'S02';
  ok(!gate(b, 'ids').ok && gate(b, 'ids').detail.includes('格式不对'), 'sceneRef 格式错被拦');
  const c = clone(); c.scenes[1].sceneRef = c.scenes[0].sceneRef;
  ok(!gate(c, 'ids').ok && gate(c, 'ids').detail.includes('重复'), '两场指向同一个剧本场次被拦');
  const d = clone(); d.scenes[0].sceneRef = 'sc_zzzzzzzz';
  ok(!gate(d, 'ids', opts).ok && gate(d, 'ids', opts).detail.includes('不在 script.json 里'), 'sceneRef 不在剧本里被拦');
  ok(gate(d, 'cast-complete', opts).ok, '找不到的场次只在 id 门报一次，不在出场人物门重复报');
  const e = clone(); e.scenes[1].scene = 3;
  ok(!gate(e, 'ids', opts).ok && gate(e, 'ids', opts).detail.includes('剧本里是第 1 集第 2 场'), '显示编号与剧本不一致被拦');
  const dupScript = JSON.parse(JSON.stringify(SCRIPT));
  dupScript.episodes[1].scenes[0].id = dupScript.episodes[0].scenes[0].id;
  ok(validateStaging(FIXTURE, { script: dupScript, art: ART }).some((x) => x.includes(`剧本里场次 id ${SCRIPT.episodes[0].scenes[0].id} 重复`)), '剧本场次 id 重复被点名');
}
{
  // 剧本第 1 集开头插一场：站位按 id 仍对原来那一场，只是场号过期
  const script = JSON.parse(JSON.stringify(SCRIPT));
  const extra = JSON.parse(JSON.stringify(script.episodes[0].scenes[0]));
  extra.id = 'sc_00000001';
  extra.flow = extra.flow.map((x, i) => ({ ...x, id: `bt_${String(i).padStart(8, '0')}` }));
  extra.characters = ['C05'];
  script.episodes[0].scenes.unshift(extra);
  const opts = { script, art: ART };
  ok(gate(FIXTURE, 'cast-complete', opts).ok, '剧本插一场：出场人物仍按 id 对上原来那一场');
  const g = gate(FIXTURE, 'ids', opts);
  ok(!g.ok && g.detail.includes('剧本里是第 1 集第 2 场'), '剧本插一场：id 门点名场号过期');
  // renumber 按 sceneRef 刷新显示编号
  const before = JSON.stringify(FIXTURE);
  const re = renumberStaging(FIXTURE, script);
  eq(JSON.stringify(FIXTURE), before, 'renumberStaging 不改入参');
  ok(re.scenes.filter((s) => s.ep === 1).every((s, i) => s.scene === FIXTURE.scenes.filter((x) => x.ep === 1)[i].scene + 1), '第 1 集各场场号后移一位');
  ok(re.scenes.every((s, i) => s.sceneRef === FIXTURE.scenes[i].sceneRef), 'sceneRef 不动');
  ok(gate(re, 'ids', opts).ok, 'renumber 后 id 门通过');
  const orphan = clone(); orphan.scenes[0].sceneRef = 'sc_zzzzzzzz';
  eq(renumberStaging(orphan, script).scenes[0].scene, orphan.scenes[0].scene, 'sceneRef 不在剧本里的场原样保留');
}
{
  // 2.x 迁移：按 (ep, scene) 查到剧本场次，补上 sceneRef
  const old = clone();
  for (const s of old.scenes) delete s.sceneRef;
  const before = JSON.stringify(old);
  const m = migrateStaging(old, SCRIPT);
  eq(JSON.stringify(old), before, 'migrateStaging 不改入参');
  eq(JSON.stringify(m), JSON.stringify(FIXTURE), '迁移结果与 3.0 样例一致');
  const bad = clone(); delete bad.scenes[0].sceneRef; bad.scenes[0].scene = 9;
  let msg = '';
  try { migrateStaging(bad, SCRIPT); } catch (err) { msg = err.message; }
  ok(msg.includes('第 1 集第 9 场在剧本里找不到'), '找不到对应场次时点名');

  const dir = mkdtempSync(join(tmpdir(), 'staging-ids-'));
  const file = join(dir, 'staging.json');
  writeFileSync(file, JSON.stringify(old, null, 2) + '\n');
  const scriptPath = join(here, '..', 'references', 'test-fixtures', 'upstream', '渡口-script.json');
  const run = (...args) => spawnSync(process.execPath, [join(here, 'novel-staging.mjs'), ...args], { encoding: 'utf8' });
  eq(JSON.parse(run('migrate', file, '--script', scriptPath).stdout).scenes[0].sceneRef, FIXTURE.scenes[0].sceneRef, 'CLI migrate 打印迁移结果');
  eq(run('migrate', file).status, 1, 'CLI migrate 缺 --script 报错');
  eq(run('migrate', file, '--script', scriptPath, '--write').status, 0, 'CLI migrate --write 正常退出');
  eq(readFileSync(file, 'utf8'), JSON.stringify(FIXTURE, null, 2) + '\n', '写回的文件与样例逐字节相同');
  eq(run('renumber', file).status, 1, 'CLI renumber 缺 --script 报错');
  eq(run('renumber', file, '--script', scriptPath, '--write').status, 0, 'CLI renumber --write 正常退出');
  eq(readFileSync(file, 'utf8'), JSON.stringify(FIXTURE, null, 2) + '\n', '编号本来就对时 renumber 不改文件');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ ${passed} 项自测全部通过`);

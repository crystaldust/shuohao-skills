#!/usr/bin/env node
// 自测：稳定 id 模块。每个 skill 自带一份 ids.mjs（skill 要能单独拷走），
// 这里查五份副本逐字节相同，再验一遍 id 的分配规则。
//   node scripts/ids-sync-selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_RE,
  assignIds,
  collectIds,
  cryptoRng,
  duplicateIds,
  isId,
  newId,
  seededRng,
} from '../skills/novel-outline/scripts/ids.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNERS = ['novel-outline', 'novel-art', 'novel-script', 'novel-staging', 'novel-storyboard'];

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed += 1; }
function eq(a, b, msg) { assert.strictEqual(a, b, `${msg} — 期望 ${b}，实际 ${a}`); passed += 1; }

/* ---------------- 副本一致 ---------------- */

const master = readFileSync(join(root, 'skills', OWNERS[0], 'scripts', 'ids.mjs'), 'utf8');
for (const s of OWNERS.slice(1)) {
  eq(readFileSync(join(root, 'skills', s, 'scripts', 'ids.mjs'), 'utf8'), master, `${s}/scripts/ids.mjs 与 novel-outline 的副本逐字节相同`);
}

/* ---------------- 格式 ---------------- */

const a = newId('sc', new Set(), seededRng('x'));
ok(ID_RE.test(a), '分配出的 id 合法');
eq(newId('sc', new Set(), seededRng('x')), a, '同一种子分配出同一个 id');
ok(newId('sc', new Set(), seededRng('y')) !== a, '换种子换 id');
ok(isId(a, 'sc') && !isId(a, 'ep'), 'isId 按前缀区分');
ok(!isId('sc_1234567') && !isId('sc_1234567i') && !isId('xx_12345678') && !isId(42), '长度、字母表、前缀、类型不对都不算');
assert.throws(() => newId('zz'), /未知的 id 前缀/);
passed += 1;

/* ---------------- 撞号 ---------------- */

const zero = () => 0;
eq(newId('ep', new Set(), zero), 'ep_00000000', '随机源恒 0 得到全 0');
assert.throws(() => newId('ep', new Set(['ep_00000000']), zero), /连续 64 次撞上已有 id/);
passed += 1;
let flip = 0;
const twoValues = () => (flip++ < 8 ? 0 : 1);
eq(newId('ep', new Set(['ep_00000000']), twoValues), 'ep_11111111', '撞号就重抽');

/* ---------------- 随机源 ---------------- */

let inRange = true;
for (let i = 0; i < 1000; i++) {
  const v = cryptoRng();
  if (!(Number.isInteger(v) && v >= 0 && v < 32)) inRange = false;
}
ok(inRange, 'cryptoRng 只出 0–31');

/* ---------------- assignIds ---------------- */

const items = [{ id: 'sc_aaaaaaaa', x: 1 }, { x: 2 }, { x: 3 }, { id: 'bad', x: 4 }, null];
const before = structuredClone(items);
const { items: out, taken } = assignIds(items, 'sc', new Set(['sc_aaaaaaaa']), seededRng('t'));
assert.deepStrictEqual(items, before, 'assignIds 不改入参');
passed += 1;
eq(out[0].id, 'sc_aaaaaaaa', '已有 id 不动');
ok(isId(out[1].id, 'sc') && isId(out[2].id, 'sc') && out[1].id !== out[2].id, '缺的补上，互不重复');
eq(out[3].id, 'bad', '格式错的 id 也不动——交给门去拦');
eq(out[4], null, '非对象原样返回');
eq(Object.keys(out[1])[0], 'id', '补的 id 排在第一个键');
ok(taken.has(out[1].id) && taken.has('sc_aaaaaaaa'), '返回的已用集合包含新旧 id');

/* ---------------- collectIds / duplicateIds ---------------- */

const doc = { episodes: [{ id: 'ep_00000001', scenes: [{ id: 'sc_00000002', flow: [{ id: 'bt_00000003' }] }] }], other: { id: 'nope' } };
assert.deepStrictEqual([...collectIds(doc)].sort(), ['bt_00000003', 'ep_00000001', 'sc_00000002'], '嵌套的合法 id 都收集到，不合法的不算');
passed += 1;
assert.deepStrictEqual(duplicateIds(['a', 'b', 'a', 'a']), ['a'], '重复的 id 只报一次');
passed += 1;

console.log(`✓ ${passed} 项自测全部通过`);

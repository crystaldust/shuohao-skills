#!/usr/bin/env node
// 自测：上游夹具。每个 skill 把自测要用的上游样例拷进自己的
// references/test-fixtures/upstream/（skill 要能单独拷走），拷贝不会自动跟着上游改。
// 这里按各 upstream/README.md 里的「- `文件` ← `来源`」逐行比对：列出的每个文件都要在，
// 并与 skills/<来源> 逐字节相同；目录里有、README 没列的 .json 也算错。
//   node scripts/fixtures-sync-selftest.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skills = join(root, 'skills');
const MAPPING = /^- `([^`]+)` ← `([^`]+)`$/;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed += 1; }

let dirs = 0;
for (const skill of readdirSync(skills).sort()) {
  const dir = join(skills, skill, 'references', 'test-fixtures', 'upstream');
  if (!existsSync(join(dir, 'README.md'))) continue;
  dirs += 1;
  const listed = new Map();
  for (const line of readFileSync(join(dir, 'README.md'), 'utf8').split('\n')) {
    const m = MAPPING.exec(line.trim());
    if (m) listed.set(m[1], m[2]);
  }
  ok(listed.size > 0, `${skill}：upstream/README.md 列出了夹具来源`);
  for (const [file, source] of listed) {
    const copy = join(dir, file);
    const origin = join(skills, source);
    ok(existsSync(copy), `${skill}：夹具 ${file} 存在`);
    ok(existsSync(origin), `${skill}：来源 ${source} 存在`);
    ok(readFileSync(copy).equals(readFileSync(origin)), `${skill}：${file} 与 ${source} 逐字节相同（上游改了就整份重新拷贝）`);
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    ok(listed.has(f), `${skill}：${f} 写进了 upstream/README.md 的来源清单`);
  }
}
ok(dirs >= 5, `找到了各 skill 的上游夹具目录（${dirs} 个）`);

console.log(`✓ ${passed} 项自测全部通过`);

// 稳定 id：集、剧本场次、节拍、分镜段、分镜切的身份。由程序分配，模型不写；已有的 id 永远不改。
// 顺序只看数组位置，「第 3 集」「E01-02」这类编号都是显示，不拿来对账。
// 这个文件在 novel-outline / novel-art / novel-script / novel-staging / novel-storyboard 各有一份，
// 必须逐字节相同（scripts/ids-sync-selftest.mjs 会查）——改的时候五份一起改。
// Zero dependencies: Node 18+ (stdlib only).

import { createHash, randomBytes } from 'node:crypto';

export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford：去掉 i l o u，免得看错
export const ID_LENGTH = 8;
export const ID_PREFIXES = ['ep', 'sc', 'bt', 'sg', 'ct'];
export const ID_RE = /^(ep|sc|bt|sg|ct)_[0-9a-hjkmnp-tv-z]{8}$/;
const MAX_TRIES = 64;

export const isId = (x, prefix = null) =>
  typeof x === 'string' && ID_RE.test(x) && (prefix === null || x.startsWith(`${prefix}_`));

/** 加密随机：256 是 32 的倍数，取低 5 位没有偏差。 */
export const cryptoRng = () => randomBytes(1)[0] & 31;

/** 确定性随机：只给样例迁移和自测使用（--seed）。种子文本 → sha256 → mulberry32。 */
export function seededRng(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) & 31;
  };
}

export function newId(prefix, taken = new Set(), rng = cryptoRng) {
  if (!ID_PREFIXES.includes(prefix)) throw new Error(`未知的 id 前缀：${prefix}`);
  for (let i = 0; i < MAX_TRIES; i++) {
    let body = '';
    for (let k = 0; k < ID_LENGTH; k++) body += ID_ALPHABET[rng()];
    const id = `${prefix}_${body}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`连续 ${MAX_TRIES} 次撞上已有 id，随机源可能坏了`);
}

/** 文档里所有已用的 id（任意深度、字段名为 id 的合法 id）。 */
export function collectIds(doc) {
  const seen = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (isId(x.id)) seen.add(x.id);
      Object.values(x).forEach(walk);
    }
  };
  walk(doc);
  return seen;
}

/**
 * 给缺 id 的条目补 id；已有 id 原样保留——格式错的也不动，合不合法交给门去判断，
 * 补 id 不替人掩盖。返回新数组和更新后的已用集合，不改入参。
 */
export function assignIds(items, prefix, taken = new Set(), rng = cryptoRng) {
  const used = new Set(taken);
  const out = (items ?? []).map((it) => {
    if (!it || typeof it !== 'object' || it.id !== undefined) return it;
    const id = newId(prefix, used, rng);
    used.add(id);
    return { id, ...it };
  });
  return { items: out, taken: used };
}

/** 同一文件内重复的 id。 */
export function duplicateIds(ids) {
  const seen = new Set();
  const dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

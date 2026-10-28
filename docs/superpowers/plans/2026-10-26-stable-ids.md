# 稳定 id（3.0.0）实施计划

**Goal:** 让小说流水线里的集、剧本场次、剧本节拍、分镜段、分镜切都带程序分配的稳定 id，所有跨文件引用、质量门和导出文件名都改为按 id 对账，彻底去掉按位置定身份的做法。

**Spec:** `docs/superpowers/specs/2026-10-26-stable-ids-design.md`

**Tech Stack:** Node.js ≥ 18 标准库（`node:crypto` 的 `randomBytes`），零依赖；每个 skill 自带 `selftest.mjs`。

## Global Constraints

- 工作目录：`/Users/lance/Development/ai-video/shuohao-skills-stable-ids`（git worktree，分支 `feat/stable-ids`，基于 `origin/main` 5612d2a）。**不要在** `/Users/lance/Development/ai-video/shuohao-skills` 里改动：`~/.claude/skills/*` 软链指向那里，是正在使用的版本。
- 只暂存明确的路径，不使用 `git add .` / `-A`。
- 每个任务先写会失败的自测（RED），再实现（GREEN）；每个任务结束时，**全部七个** skill 的自测都要通过。
- 遵守 AGENTS.md：中文文案不用单字词；skill 自包含；每个 skill 的样例只用自己的；渲染产物不进版本库。
- 不推送、不发 PR、不打标签，等用户确认。
- 消息、门标签用中文，并同步更新英文 I18N 和 `GATE_LABELS_EN`。

## 基线

```bash
cd /Users/lance/Development/ai-video/shuohao-skills-stable-ids
for f in skills/*/scripts/selftest.mjs; do node "$f" | tail -1; done
# 233 / 151 / 337 / 249 / 154 / 99 / 336，全部通过
```

## Task 0：共享 `ids.mjs` 与副本同步检查

- 新建 `skills/novel-outline/scripts/ids.mjs`（权威副本）：
  - `ID_ALPHABET`、`ID_PREFIXES = ['ep','sc','bt','sg','ct']`、`ID_RE`
  - `isId(x, prefix?)`
  - `newId(prefix, taken: Set, rng = cryptoRng)`：撞上已有 id 时重抽
  - `assignIds(items, prefix, taken, rng)`：返回新数组，只补缺的
  - `seededRng(seed)`：供自测和样例迁移使用的确定性随机源
- 原样复制到 novel-art、novel-script、novel-staging、novel-storyboard 的 `scripts/`（art 和 staging 只做格式校验，但保持同一份）。
- 新建 `scripts/ids-sync-selftest.mjs`：五份副本逐字节相同；`newId` 的格式、种子可复现；`assignIds` 不改入参。
- **验证**：`node scripts/ids-sync-selftest.mjs`。

## Task 1：novel-outline 3.0.0

- **schema**：`episodes[].id`（`ep_`）必填；`beats[]` 增加 `episodeRef`（由 `ids` 按 `episode` 集号补上），`episode` 保留，作为作者写的集号和显示缓存。
- **门**：新增 `ids` 门：分集 id 齐全、格式对、唯一；每个爽点的 `episodeRef` 都在、指向本大纲里的一集，并且那一集的 `ep` 等于 `episode`。门总数 14 → 15。其余门的集号算术不变（集号连续门 + ids 门保证集号等于位置）。
- **命令**：`ids [--write] [--seed s]`、`renumber [--write]`、`migrate`（与 `ids` 相同）。
- **资产清单**、渲染：不变，仍按集号显示。
- **样例**：`examples/渡口-outline.json` 用 `migrate` 加固定种子转换一次后提交。
- **自测**：
  - id 门的击穿用例：缺 id、格式错、重复、`episodeRef` 悬空。
  - 插入一集后，`renumber` 正确重编集号，爽点仍然指向原来那一集。
  - `migrate` 在固定种子下的结果可复现。
  - 现有涉及 `b.episode` 的用例全部改写。
- **文档**：`schema.md`、`episode-pass.md`（分批合并时保留 id）、SKILL.md（Step 5 写完运行 `ids --write`）、README / README.en、断言数。

## Task 2：novel-art 3.0.0

- `seed` 把 `usage.episodes` 写成集 id 数组。
- `render` 新增可选 `--outline`：给了就显示集号，没给就显示「N 集」。
- `validate`：`usage.episodes` 里的元素必须是 `ep_` id。
- 命令 `migrate <2.x art> --outline <3.0 outline>`：按集号映射成 id。
- 样例与 `references/test-fixtures` 同步。
- 自测与文档同上。

## Task 3：novel-script 3.0.0

- **schema**：`episodes[].id`（从大纲照抄）、`scenes[].id`（`sc_`）、`flow[].id`（`bt_`）必填；`hookBeat` 改成 `bt_` id。
- **门**：
  - 新增 `ids` 门：齐全、格式、唯一；给了 `--outline` 时，`episodes[].id` 必须存在于大纲，且 `ep` 等于大纲里那一集的集号。门总数 10 → 11。
  - `hook-open` 按 id 找这一拍在全集里的位置；hookBeat 悬空单独报。
  - `beats-claimed` 按 `episodeRef` 对上大纲爽点。
- **seed**：照抄 `episodes[].id`；场次留空，由模型写，写完运行 `ids --write`。
- **渲染**：「第 N 场」「第 N 拍」由位置推算；hooked 高亮按 id 判断。
- **命令**：`ids`、`migrate <2.x script> --outline <3.0 outline>`（集号 → id；补 `sc_` / `bt_`；`hookBeat [s,b]` → 对应的 `bt_`）。
- **样例**：迁移 `examples/渡口-script.json` 和 `references/test-fixtures/upstream/*`（重新拷贝 3.0 的 outline、art）。
- **自测**：id 门击穿用例；hookBeat 悬空；在一场中间插入一拍后，`ids` 只补新的那一拍，其余 id 不变；`migrate` 可复现。

## Task 4：novel-staging 3.0.0

- **schema**：新增 `sceneRef`（`sc_`）作为身份；`ep`、`scene` 保留，作为显示缓存，由 `ids` 门对照剧本检查。
- **seed**：照抄 `sceneRef`。
- **validate `--script`**：按 id 查场次（替换 `novel-staging.mjs:460` 那一处按位置的查找）。
- **门**：新增 `ids` 门（`sceneRef` 格式；给了 `--script` 时必须存在），门总数 8 → 9。
- **标签**：`sceneLabel` 不变（读显示缓存）；`data-scene` 仍然是数组下标，只在页面内部使用，不导出。
- **命令**：`migrate <2.x staging> --script <3.0 script>`：用 `(ep, scene)` 在剧本里查到对应场次，改写成 `sceneRef`。
- **样例**：迁移样例与 upstream 夹具。
- **自测**：L202 那个按位置修改剧本的用例改成按 id；在剧本里插入一场后，站位仍然对得上原来那一场；页面算法重建测试不受影响。

## Task 5：novel-storyboard 3.0.0

- **schema**：
  - `episodes[].id`
  - `segments[].id`（`sg_`）、`segments[].sceneRef`
  - `cuts[].id`（`ct_`）、`cuts[].beatIds`
  - 删掉 `sceneIndex`、`beats` 区间
- **expandScript**：每一场带 `id`，每一拍带 `id`，并建立 `byId` 索引。
- **门**：
  - `segment-id` 连号门换成 `ids` 门（齐全、格式、唯一；`sceneRef` 和 `beatIds` 必须存在于剧本），门总数保持 18。
  - `coverage` 改成按 id 序列比对：漏拍、重拍、乱序、不认识的 id 分别报出；场次顺序倒退按剧本位置判断。
  - `dialogue-fit`、`h3-dialogue`、Seedance 的 `{}` 台词都改成按 `beatIds` 取拍。
- **标签**：`segLabel(ep, i)` = `E01-02`，切标签 = `#k`，用于报告、对白表和门的提示信息。
- **导出**（H3 / Seedance / `--frames`）：路径改为 `<段 id>/<切 id>.png`；manifest 加上 `label` 和 `order`；`prompt.md` 的 Picture 对照表列出文件名。report `--frames` 也按同样的路径查找。
- **seed**：`seedScenes` 每场带 `sceneRef`，每拍带 `id`（替代 `n` 作为认领依据，`n` 仍然显示）。
- **命令**：`ids`、`migrate <2.x storyboard> --script <3.0 script>`：`sceneIndex` → `sceneRef`，`[起, 止]` → 展开成 `beatIds`，补 `sg_` / `ct_`。
- **样例**：迁移样例与 upstream 夹具；样例里 h3Prompt 中的 Picture k / [Shot k] 不受影响，因为它们按顺序推导。
- **自测**：
  - 全部 B1–B6 中依赖段号、`sceneIndex`、`beats` 的用例改写。
  - 新增：剧本插入一拍后，覆盖门点名这一拍；导出路径按 id 命名；重排段后 manifest 的 label 变了但 id 不变。
- **文档**：`schema.md`（同时修掉旧文档里 `E01-01-f1.png` 和代码不一致、`h3Prompt` 默认语言写错这两处）、`storyboard-pass.md`、`frame.md`、`h3-prompt.md`、`seedance-prompt.md`、`report-style.md`、SKILL.md、README / README.en。

## Task 6：收尾

- 重新拷贝各 skill 的 `references/test-fixtures/upstream/*`，与上游样例逐字节一致（加一个检查脚本，或写进 `ids-sync-selftest.mjs`）。
- CHANGELOG 3.0.0：破坏性变更与迁移表、新命令、门数变化。
- 根 README / README.en / README.zh：版本号与断言数。
- AGENTS.md：加一条"身份用 id，不用位置"。
- SKILL.md frontmatter：五个 skill 的 `version: 3.0.0`。
- 全部自测、`scripts/report-selftest.mjs`、`ids-sync-selftest.mjs` 通过。
- **不打标签、不推送**：`v2-final` 标签和 PR 等用户确认后再做。

## 验证命令（每个任务结束都要跑）

```bash
cd /Users/lance/Development/ai-video/shuohao-skills-stable-ids
for f in skills/*/scripts/selftest.mjs; do node "$f" | tail -1 || exit 1; done
node scripts/report-selftest.mjs | tail -1
node scripts/ids-sync-selftest.mjs | tail -1
# 端到端：渡口样例按 3.0 跑一遍 validate
S=skills; node $S/novel-script/scripts/novel-script.mjs validate $S/novel-script/examples/渡口-script.json --outline $S/novel-outline/examples/渡口-outline.json --art $S/novel-art/examples/渡口-art.json
node $S/novel-staging/scripts/novel-staging.mjs validate $S/novel-staging/examples/渡口-staging.json --script $S/novel-script/examples/渡口-script.json --art $S/novel-art/examples/渡口-art.json
node $S/novel-storyboard/scripts/novel-storyboard.mjs validate $S/novel-storyboard/examples/渡口-storyboard.json --script $S/novel-script/examples/渡口-script.json --no-log
```

## 风险

| 风险 | 应对 |
| --- | --- |
| storyboard 改动面最大（id 用在 30 多处，自测 300 多项） | 最后做；先让 expandScript 带上 id，再逐道门改 |
| 样例迁移后各 skill 的夹具对不上 | 迁移顺序固定，并用夹具一致性检查兜底 |
| 模型仍然按 2.x 习惯写区间、写场序 | 新的 `ids` 门和结构校验会直接拦下；SKILL.md、*-pass.md 写明"不写 id，写完运行 ids" |
| 外部用户手上的 2.x 文件 | `migrate` 命令 + CHANGELOG 迁移表 + `v2-final` 标签 |

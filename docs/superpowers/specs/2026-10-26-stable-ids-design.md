# 稳定 id 设计（3.0.0）

## 问题

小说流水线里有六类东西靠**位置**当身份：

| 位置身份 | 现在的写法 | 谁靠它对账 |
| --- | --- | --- |
| 集 | `ep` 集号 | 大纲 `beats[].episode`、剧本 / 分镜按 `ep` 对上大纲和剧本、美术 `usage.episodes` |
| 剧本场次 | 这一集的第几场 | 站位 `(ep, scene)`、分镜 `sceneIndex`、剧本 `hookBeat[0]` |
| 剧本节拍 | 这一场 `flow` 的第几拍 | 分镜 `cut.beats: [起, 止]`、剧本 `hookBeat[1]` |
| 分镜段 | 段号 `E01-01`，门要求按顺序连号 | 导出文件夹名、投产清单、配音对齐单 |
| 分镜切 | 段内第几切 | 分镜图文件名 `f<切序>.png`、Picture k |
| 站位场次 | `(ep, scene)` | 用这两个数字在剧本里定位 |

在中间插入任何东西，后面所有编号都会顺移，引用它们的地方就悄悄指向了别的内容：
- 站位把开场位置挂到了另一场上。
- 分镜认领的节拍区间错开一格。
- 已经生成好的视频按文件夹名对不回原来的段。

质量门只能拦下一部分（比如节拍没人认领），拦不住"认领了错的拍"。2.x 的修补方式（重新编号后再人工对一遍）正是这种问题的来源。

## 原则

1. **身份是 id，顺序是数组位置，编号是显示。**每个有顺序的条目带一个永不改变的 `id`；顺序只由它在数组里的位置决定；「第 3 集」「第 2 场」「E01-02」都在渲染、导出时按位置推算，不作为对账依据。
2. **id 由程序分配，模型不写。**模型新写的条目不带 `id`，`ids` 命令补上；已有的 `id` 永远不改。模型如果编了 id，格式不对会被门拦下。
3. **对账一律用 id。**跨文件引用、门、导出文件名都用 id；任何"第几个"的查找都要删掉。
4. **一次切换，不长期兼容。**3.0.0 起 id 必填，2.x 文件用 `migrate` 一次性转过来；不保留按位置定位的回退路径。

## id 格式

`<前缀>_<8 位小写 Crockford base32>`，例如 `sc_k3f9q2xa`。

| 前缀 | 是什么 | 谁分配 |
| --- | --- | --- |
| `ep_` | 集 | novel-outline（`ids`）；下游 `seed` 照抄 |
| `sc_` | 剧本场次 | novel-script（`ids`） |
| `bt_` | 剧本节拍（`flow` 里的一拍） | novel-script（`ids`） |
| `sg_` | 分镜段 | novel-storyboard（`ids`） |
| `ct_` | 分镜切 | novel-storyboard（`ids`） |

- 字母表 `0123456789abcdefghjkmnpqrstvwxyz`（去掉 i l o u，避免看错）；32⁸ ≈ 1.1×10¹²。一部 60 集的剧约 4,000 个 id，随机碰撞的概率约 10⁻⁵；分配时还会跳过本文件里已有的 id，所以同一文件内绝不重复。
- 随机而不是递增：剧本、分镜按集分批写，各批之间没有共享计数器也不会撞号；删掉的 id 也不会被重新分配。
- 正则 `/^(ep|sc|bt|sg|ct)_[0-9a-hjkmnp-tv-z]{8}$/`。
- 已有的 `C01` / `S01` / `P01` / `B01` 不变：它们本来就是显式 id，不靠位置。

**自包含：**每个用到 id 的 skill 自带一份相同的 `scripts/ids.mjs`（AGENTS.md：skill 要能单独拷走）。仓库根的 `scripts/ids-sync-selftest.mjs` 检查这几份副本逐字节相同。

`ids.mjs` 提供：
- `newId(prefix, taken, rng)`：`rng` 可注入，自测用固定种子。
- `isId(x, prefix?)`。
- `assignIds(items, prefix, taken, rng)`：只给缺 id 的条目补，返回新数组，不改入参。

## 各 skill 的新结构

### novel-outline

- `episodes[].id`（`ep_`）必填。`ep` 保留，作为显示用的集号，门要求 `ep === 位置 + 1`（现有规则）。
- `beats[].episode`（集号）改成 `beats[].episodeRef`（`ep_` id）。爽点间隔、major 时机这些门按被引用那一集在数组里的位置算。
- 插入一集：在数组中间放一条不带 id 的分集，`ids` 补 id，`renumber` 按位置重写所有 `ep`。其他集的 id 和爽点引用都不受影响。

### novel-art

- `usage.episodes` 由集号数组改成集 id 数组（`seed` 从大纲搬）。`render --outline` 时显示成集号；没给大纲就显示「N 集」计数。

### novel-script

- `episodes[].id` 必填，`seed` 从大纲照抄。`ep` 是显示用的缓存；给了 `--outline` 时，门检查它等于大纲里该 id 的集号。
- `scenes[].id`（`sc_`）、`scenes[].flow[].id`（`bt_`）必填。
- `hookBeat` 由 `[场, 拍]` 改成一个 `bt_` id。门照旧按"全集第几拍"判断是否落在冷开场窗口内，位置现算。
- 「第 N 场」「第 N 拍」只在渲染时出现。

### novel-staging

- `scenes[].ep` + `scenes[].scene` 改成 `scenes[].sceneRef`（`sc_` id），并保留 `ep` 作为显示缓存。
- `seed` 从剧本照抄 `sceneRef`；`validate --script` 按 id 找剧本场次。
- 显示用的「第 N 集第 M 场」在给了 `--script` 时按剧本位置推算；没给时按站位文件内同一集的顺序推算。

### novel-storyboard

- `episodes[].id` 照抄剧本。`segments[].id` 改成 `sg_`，不再要求连号；`segments[].sceneIndex` 改成 `sceneRef`（`sc_`）。
- `cuts[].id`（`ct_`）必填；`cuts[].beats: [起, 止]` 改成 `cuts[].beatIds: [bt_…]`，**明确列出每一拍**，不使用区间。
- 覆盖门改为：
  - 把全场的 `beatIds` 按段、切的顺序连起来，必须恰好等于剧本这一场的节拍 id 序列。
  - 漏拍、重拍、乱序、不认识的 id 各报各的。
  - 新插入的节拍没人认领时会被点名，不会悄悄并进相邻的切。
- **显示标签**：「E01-02」= 集号 + 段在集内的位置，「#3」= 切在段内的位置，只用于报告和对白表。
- **导出**：文件夹按段 id 命名（`sg_xxxxxxxx/`），分镜图按切 id 命名（`ct_xxxxxxxx.png`）。`manifest.json` 每段同时给出 `segment`（id）、`label`（E01-02）和顺序；`prompt.md` / `seedance.md` 里的 Picture k 对照表列出对应的文件名。生成好的素材按 id 对回，与插入、重排无关。
- `--frames` 目录按同样的 `<段 id>/<切 id>.png` 查找。

### novel-characters、character-refs

不涉及集、场、拍、段、切，不改动。

## 新命令

每个用到 id 的 skill（outline、script、storyboard 补 id；staging 只有引用）新增：

| 命令 | 作用 |
| --- | --- |
| `ids <file.json> [--write]` | 给缺 id 的条目补 id。只补不改；默认打印结果，`--write` 原地写回 |
| `migrate <2.x 文件> [--outline/--script …] > 3.0 文件` | 把 2.x 文件转成 3.0：补 id，并把按位置的引用改写成按 id 的引用。迁移顺序固定：outline → art / script → staging / storyboard，下游迁移时必须给已迁移的上游文件 |
| `renumber <outline.json> [--write]`（仅 outline） | 按位置重写 `ep` 显示集号 |

`seed` 产出的骨架：从上游照抄的 id 原样保留；新条目（模型要写的场次、节拍、段、切）不带 id，写完运行 `ids --write`。

## 新质量门

每个相关 skill 新增一道 `ids` 门（编号顺序：插在现有第一道门之前）：
- id 齐全、格式对、本文件内唯一；
- 引用的 id 在给出的上游里都存在（`--outline` / `--script`）。

门数的变化：
- outline 14 → 15
- script 10 → 11
- staging 8 → 9
- storyboard 18 → 18：`segment-id` 连号门删掉，换成 `ids` 门

## 迁移的确定性

`migrate` 生成的 id 来自随机数，所以同一份 2.x 文件迁移两次，得到的 id 不同。这是预期行为：迁移只做一次，结果提交进版本库。样例文件迁移一次后固定下来；自测里的迁移用例注入固定种子。

## 不做的事

- 不保留 2.x 的按位置字段作为备选（违反原则 4）。
- 不在 skill 里做"上一版对比"去检测 id 被重新分配：skill 不保存历史。跨版本的身份追踪由平台（ai-video-platform）负责，它按 id 落库。
- `C01` 这类编号在大纲重新生成时会不会被重排，不在本次范围内：它们是显式 id，规则是"大纲写定后不重排"，本次在 schema.md 里写明。

## 发布

- 2.x 最后的状态打标签 `v2-final`。
- 涉及的五个 skill（outline、art、script、staging、storyboard）升到 3.0.0；characters、character-refs 版本不变。
- CHANGELOG 写"破坏性变更与迁移"表，格式与 2.0.0 那次一致。
- 根 README 的管线图不变：站位到分镜的衔接仍然是抄 `blocking`，本次不改这一点。
- AGENTS.md 加一条：**身份用 id，不用位置**。

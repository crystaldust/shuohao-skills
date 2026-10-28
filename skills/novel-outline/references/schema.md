# outline.json 结构

五件套的载体。**模型只管填这份 JSON**，Markdown 和 report.html 由 `render` 渲染出来，资产清单由脚本汇总——五件套是四件模型写 + 一件算出来的。

```json
{
  "source": "书名",
  "lang": "zh",
  "params": { "episodes": 60, "minutesPerEpisode": 2, "genre": "女频逆袭", "adaptMode": "抽核", "preferences": [] },
  "adaptation": { "core": "…", "keep": [], "cut": [], "merge": [], "risks": [] },
  "characters": [ { "id": "C01", "name": "…", "role": "…", "arc": "…", "from": ["原著…", "合并：…"] } ],
  "scenes": [ { "id": "S01", "name": "…", "primary": true, "reusePlan": "…" } ],
  "beats": [ { "id": "B01", "type": "打脸", "weight": "major", "episode": 3, "episodeRef": "ep_k3f9q2xa", "setup": "…", "payoff": "…" } ],
  "episodes": [ { "id": "ep_k3f9q2xa", "ep": 1, "synopsis": "…", "hook": "…", "suspense": "…", "sceneIds": ["S01"], "characterIds": ["C01"], "propIds": ["P01"], "crowdPlan": "…", "warnings": [] } ]
}
```

## params

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `episodes` | 是 | 总集数，正整数。分集数量必须与它一致 |
| `minutesPerEpisode` | 是 | 单集时长（分钟） |
| `genre` | 是 | 题材，**决定爽点类型**，不许缺。投放平台的差异不单设字段，直接体现在 `thresholds` 上 |
| `adaptMode` | 是 | `忠实` / `抽核` / `借壳`，只能这三个 |
| `preferences` | 否 | 用户点名要保的角色、戏 |
| `thresholds` | 否 | 逐项覆盖质量门阈值：`maxLeads`(5) / `maxSupport`(10) / `maxFunctional`(10) / `maxBeatGap`(3) / `maxPrimaryScenes`（缺省不是常数，**随集数动态**：4 + ⌈集数/10⌉ 夹在 5–15，60 集 → 10。按 AI 短剧定的——场景是生成的，上限守的是一致性资产不是搭景钱）。短篇建议收紧角色档 |

## adaptation 改编说明

`core` 一句话核心，必填。`keep` / `cut` / `merge` 每条 `{what, why}`，`keep` 至少一条；**`adaptMode` 不是忠实时 `cut` 不能为空**。`keep` 可带 `evidence`——**原文逐字片段**，禁止凭书名脑补的对策就在这：关键取舍要能指回原文。`risks` 每条 `{what, plan}`。

两个可选的**决策补注**，报告的「关键决策」区块会展示：

- `cutNote` — 砍线的结论句（「这意味着：全剧终点是……原著后 30 章基本不用」这种），说清砍完之后故事的终点变成了什么
- `mergeNote` — 合人的补注，通常写主角组入选理由（谁有完整转变弧）

给了就不能是空字符串，`validate` 会拦。大爆点落点列表**不用写**——报告从 `beats` 里自动算。

## characters 人物表

每个字段都以校验器为准，一个不多一个不少：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `C01` 格式，全局唯一，分集靠它引用 |
| `name` | 是 | 姓名；功能性角色用称呼标签（「急诊医生」） |
| `role` | 是 | 定位一句话：女主 / 搅局配角 / 渡口的报时人…… |
| `tier` | 是 | 三档之一，见下表 |
| `arc` | lead / support 必填 | 人物弧；functional 可省——医生就是来缝针的 |
| `from` | 是 | **← 改动记录**，非空数组：原著对应谁、合并了谁、纯原创写 `["原创"]` |

- `tier` 只能三档——一刀切的角色上限混淆了「观众要记住谁」和「制作要维护多少张脸」，分档把它拆开：

  | tier | 是谁 | 上限 | 规则 |
  | --- | --- | --- | --- |
  | `lead` | 主角组（男女主 + 主反派） | 1–5 人 | `arc` 必填 |
  | `support` | 有名字的重要配角（亲属、闺蜜、副反派） | ≤ 10 | `arc` 必填 |
  | `functional` | 功能性角色（医生、秘书、店员） | ≤ 10 | **占脸不占名**：`name` 用称呼标签（「急诊医生」）；`arc` 可省——医生就是来缝针的 |

  无名背景人不进表、不追踪、不限量。

  **这份表是下游 novel-characters 的角色清单**：谁进谁不进、谁是主角组在这里定死，角色设定照着做，不用再判断一遍轻重（`tier` 对应过去就是 `importance`：`lead` → protagonist、`support` → supporting、`functional` → minor）。反过来，手上已经有 cast.json 的话也能映射进来：protagonist/major → `lead`，supporting → `support`，minor → `functional`

## scenes

- `id` 格式 `S01`，全局唯一；`name` 必填；`primary` 必填布尔（主场景上限随集数动态，见 `thresholds`）
- **在全剧只出现一次的场景必须带 `reusePlan`**（规避方案：复用哪个现有环境资产、换什么时段天气改出来）

## props 叙事道具

- **可选字段**。没写照常通过全部质量门（`prop-cap` 与 `refs` 两道会明说跳过）；写了就按下面查
- `id` 格式 `P01`，全局唯一；`name` 必填
- **`function` 必填——这一层唯一要拍板的东西：这件物件在戏里承载什么。** 填不出来说明它不是叙事道具，是场景陈设，那归 `novel-art` 的场景锚点管，不进这张表
- `beatIds` 可选：它托起哪几个爽点。写了就必须指向 `beats` 里真实存在的 id
- 上限 `maxProps` 默认 8 件（进 `params.thresholds` 可覆盖）。跟主角数量一个量级——**只收有特写、跨集出现、承载剧情的**
- 分集用 `episodes[].propIds` 引用。**没有任何一集引用的道具会被 `refs` 门点名**——跟失业角色、空转场景同一个判据

边界：尺度、锚点、状态变体、白底提示词都是 `novel-art` 的活，不在这里定。这张表回答「哪几件物件承载剧情、各自承载什么」，美术层回答「它长什么样、怎么保证六集都长一样」。

## beats 爽点表

- `id` 格式 `B01`；`type` 自由文本（打脸/揭破/反转…）；`weight` 只能 `major` / `minor`（缺省算 minor）
- `episode` 是作者写的集号——分集不再列 beatIds，节奏条和资产清单都从这里算
- `episodeRef` 是这个爽点归属的集 id，**由 `ids` 按 `episode` 补上，不要手写**。补上之后它是真相，`episode` 是显示缓存：`ids` 门检查两者一致（`episodeRef` 指向的那一集的 `ep` 必须等于 `episode`），手工改了集号却没改归属会被拦下。写爽点表时分集还不存在，所以这一步在分集写完之后做
- 硬规则：相邻爽点间隔 ≤ `maxBeatGap`，开头结尾无真空；**至少一个 major，且最早的 major 不能落在最后一集**

## episodes 分集梗概

- `id` 是集 id，`ep_` 加 8 位字母数字（`ep_k3f9q2xa`），**由 `ids` 命令分配，不要自己编**；分配后永远不改。下游（剧本、美术、站位、分镜）都按它对账，不按集号
- `ep` 从 1 连续编号，总数等于 `params.episodes`
- `synopsis` / `hook` / `suspense` 三栏**都必填**——【钩子】【悬念】空了视为未完成
- **叙述体**：三栏里出现 `「」『』“”` 引号对白就是在写剧本，越界，validate 会拦
- `sceneIds` / `characterIds` 必填且必须指向已登记的 id；每个角色至少出现一集、每个场景至少用一次
- `propIds` 可选（写了 `props` 才有意义），必须指向已登记的道具 id；每件道具至少出现一集
- `characterIds` ≥ 3 的集必须写 `crowdPlan`（同框拆解方案）。**校验按人数判，是代理指标**——如果这一集三人实际不同框（分处不同场次），把这个事实写成方案即可：「三人分处两场，无同框，分场拍」，照样通过
- `warnings`：梗概里扫到生成难点关键词（雨戏/肢体接触/人群/手部特写）就必须列进来，宁可多报

## 校验

```bash
node scripts/novel-outline.mjs validate outline.json --stage skeleton|beats|full
node scripts/novel-outline.mjs checkup outline.json   # 只打印 15 道质量门 ✓/✗
```

stage 就是流程门：骨架拍板前过 `skeleton`，**写分集之前必须过 `beats`**（爽点间隔和 major 时机错了，分集写完全废），交付前过 `full`。

## 稳定 id 与插入一集

集号只是用于显示的编号，身份是 `id`。顺序只看 `episodes` 数组里的位置。

```bash
node scripts/novel-outline.mjs ids outline.json --write        # 补集 id、补爽点归属（已有的不动）
node scripts/novel-outline.mjs renumber outline.json --write   # 按位置重编集号，爽点集号跟着归属同步
node scripts/novel-outline.mjs migrate old-outline.json --write # 2.x 大纲迁移到 3.0（等同 ids）
```

- **插入一集**：把新的一集放进数组（不写 `id`，`ep` 随便写），先运行 `renumber --write`：每集的 `ep` 改成位置 + 1，每个爽点的 `episode` 按 `episodeRef` 同步，`params.episodes` 跟着更新；再运行 `ids --write` 给新的一集补 id，新写的爽点这时按集号补上 `episodeRef`。顺序反过来也行，但如果有还没 `episodeRef` 的爽点、集号又和位置对不上，`ids` 会拒绝补归属，免得新爽点挂到同号的旧集上。其他集的 id 不变，下游的引用都不会挂错；下游的集号显示缓存会被各自的 `ids` 门点名，按顺序运行 script 的 `renumber --outline`、storyboard 的 `renumber --script`、staging 的 `renumber --script` 刷新
- **删掉一集**：直接从数组里删，运行 `renumber --write`；归属在被删那一集的爽点会被 `ids` 门点名，改归属或删掉这个爽点
- `--seed <文本>` 让 `ids` 使用确定性随机源，同样的输入得到同样的 id。**只用于样例与自测**，真实项目不加
- `C01`、`S01`、`P01`、`B01` 这些编号由模型在骨架里写定，写定后不重排——它们本来就是显式 id，下游直接引用

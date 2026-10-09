# Jev（TypeSafe System One）影子试点

> 状态：脚手架已就绪，**默认关闭**。仓库内没有任何真实 Jev 调用，测试全部走本地 mock。

## 目标

用 Jev 的 Noul / Choice / Score 判定，与产品现有规则（或人工决策）做**并行对照**，只记录、不生效。任何结果都不会改变导入、POI 合并或地理编码的行为。

| 任务 | 触发点 | 对照对象 | 问题 |
| --- | --- | --- | --- |
| `import-gate` | `POST /api/import-guide` 返回后 | 规则：抓取成功 + 可信分 ≥45 + 摘要/正文 ≥20 字（`isUsableImportedSource`） | `is_travel_content` / `is_shell_page` / `is_commercial`（Noul），`city_match`（Choice，4 项含 `not_stated`），`detail_level`（Score，4 级） |
| `poi-duplicate` | 运营在“重复 POI”里做出合并/驳回 | 人工决策（merge→same，reject→different） | `link_state`（Score：不同地点 / 相关但可能不是同一个 / 同一地点不同叫法），`part_of`（Noul）；距离由程序算好、以文字分桶传入 |
| `geocode-choice` | 生成路线后的 AMap POI 搜索（`onCandidates` 钩子） | `chooseGeocodeCandidate` 的选择 | `pick`（Choice：`c_0…c_n` + `none_match`）；**不发送坐标** |

所有 Choice 都会**再问一次反序选项**（POI 任务则交换 A/B），记录 `orderConsistent`，用来量化顺序偏差。

## 开关与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JEV_SHADOW_ENABLED` | `false` | 必须为 `true` **且** 有 `TYPESAFE_API_KEY` 才会调用 |
| `TYPESAFE_API_KEY` | 空 | 只从环境变量读取，不写日志 |
| `JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` | 可指向本地 mock |
| `JEV_MODEL` | `jev-latest` | |
| `JEV_SHADOW_TIMEOUT_MS` | `800` | 超时即记 `timeout`，不重试 |
| `JEV_SHADOW_SAMPLE_RATE` | `1` | 0–1 抽样率 |
| `JEV_SHADOW_MAX_IN_FLIGHT` | `8` | 并发上限，满了直接丢弃（记为 `busy`，不排队） |

## 不阻塞、不改变行为

- `scheduleShadowJudgment()` 同步返回，真正的请求在 `setImmediate` 之后执行；任何异常都被吞掉。
- 429/529/401/422、超时、响应格式不对 → 记一行 `ok:false` 的日志，不重试、不影响请求。
- 集成测试 `test/integration/jev-shadow.test.mjs` 验证：开启与关闭时 `/api/import-guide` 的响应一致。

## 个人数据

- 只发送公开内容：导入页面的标题/摘要/正文摘录、POI 名称/别名/类别/城市、AMap 候选名称/地址/类型编码。
- 发送前统一脱敏手机号、邮箱、身份证号（`server/shadow/privacy.mjs`）。
- `assertNoPersonalData` 拒绝含 `profileId`、`gps`、`lat/lng`、`userAgent`、`ip`、`email`、`phone`、`comment`、`checkin` 等字段的载荷，命中则只记 `blocked-personal-data`，不发送。
- 运营的 `actor`、`reason`，用户打卡、评论、定位**从不发送**。
- 上线前仍需完成合规决策清单中的第三方处理/出境评估（见 `合规决策清单.md`）。

## 日志与汇总

- 结果写入 `shadow-judgments` 流（JSONL：`shadow-judgments.jsonl`；PG：migration 0007 已加入该 stream）。
- 行字段：`task`、`ruleDecision`、`jevDecision`、`agreement`、`orderConsistent`、`answers`、`shuffledAnswers`、`latencyMs`、`model`、`usage`、`state`（仅公开内容，用于后续标注）。
- 汇总：`GET /api/ops/shadow-judgments`（管理员）→ 每个任务的总数、错误数、一致率、顺序一致率、P50/P95 延迟。

## 本地 mock

```bash
JEV_MOCK_PORT=5499 node scripts/jev/mock-server.mjs
JEV_SHADOW_ENABLED=true TYPESAFE_API_KEY=mock JEV_API_URL=http://127.0.0.1:5499/v1/systemone npm start
```

mock 的回答是**占位值，不是模型判断**：Noul 固定 0.5（可用 `JEV_MOCK_NOUL=id=0.9,...` 覆盖），Choice 永远选第一个选项（故意制造顺序偏差，验证反序重测能发现它），Score 取中间档。

## 标注包（约 300 条）

- `eval/jev-labeling/samples.jsonl`（303 条）由 `node scripts/jev/build-labeling-kit.mjs` 生成，格式见 `eval/jev-labeling/annotation-format.md`。
  - `poi-duplicate` 71 条：种子目录内同城 POI 两两配对 + 名称与其别名（正反两种顺序）。
  - `geocode-choice` 26 条：种子 POI 名称/别名作为站点名；**AMap 候选需在试点中采集补齐**（我们没有 key，也不编造候选）。
  - `import-gate` 206 条：**合成模板文本**（`synthetic:true`），不含营业时间、价格、地址等任何事实，只用于跑通流程和检查壳页面/城市判断；真实准确率必须用试点中真实导入内容的标注来衡量。
- 所有 `label` 均为 `null`，需人工标注；单测保证生成器不会预填标签、合成文本不含时间/价格。
- 评测：`node scripts/jev/eval-labels.mjs --labels eval/jev-labeling/samples.jsonl --answers answers.jsonl`，或 `--run --url <mock 地址>`。

## 待核实

- 响应格式按 https://docs.typesafe.ai/api.md（2026-10-09 读取）：`{model, answers:{id:{type, noul|choice+probabilities+confidence|score+legend+probabilities+confidence}}, usage}`。解析器对缺字段宽容（缺 `answers` 记 `malformed-response`）。正式试点前用真实 key 做一次连通性验证。
- 中文准确率、价格、SLA、数据留存与出境条款需要与 TypeSafe 书面确认。
- 导入接口目前没有前端传 `city`，`city_match` 多数会是 `not_stated`；如要评估城市匹配，需前端在导入时附带所选城市。

## 判定上线的建议门槛（需人工决定）

在真实标注集上：`import-gate` 一致率与人工准确率均优于现有规则、`orderConsistency ≥ 95%`、P95 延迟 < 800ms、错误率 < 2%。达不到就保持影子模式或放弃。

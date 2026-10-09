# 生成质量回归

每次改提示词、换模型或换供应商后运行：

```bash
npm run eval:generation                     # 离线 mock runner，校验评分管线本身
node scripts/eval/run-generation-eval.mjs --runner http --url http://127.0.0.1:5401
# ↑ 调用运行中的服务 POST /api/generate-routebook，需要 ROUTEBOOK_API_TOKEN，会消耗真实模型额度
```

- 用例：`eval/generation/cases.jsonl`（8 条）。只引用种子目录里已有的 POI 名称/别名，不写营业时间、价格。
- 确定性检查（复用产品校验器）：必去/避开（`buildConstraintValidation`）、天数、站点数区间、所有站点坐标在城市范围内。
- mock runner 只验证评分代码；**真实质量必须用 http runner 对真实模型跑**，并保留每次报告做对比。
- 待补：主观质量（顺路程度、节奏）需要人工评分表；用例需要扩到真实用户输入（脱敏后）。

## 看板指标（`GET /api/dashboard`）

| 指标 | 状态 |
| --- | --- |
| 有效执行旅程数 / 率 | 已有（`effectiveExecutedRoutebooks` / `effectiveExecutionRate`） |
| 约束满足率 | 新增 `constraintSatisfactionRate`：AI 生成路书当前版本中，必去/避开“已纳入”+ 预算“可控”的项 / 结论明确的项；待复核、未设置单独计数 |
| 生成耗时 P50/P95 | 已有（`generationLatencyMs`） |
| 曝光 → 点击 | 已有（`productAnalytics.overallCtr`） |
| 点击 → 跳转 | **未采集**：`redirectRate: null`，`redirectRateStatus: 'not-instrumented'` |

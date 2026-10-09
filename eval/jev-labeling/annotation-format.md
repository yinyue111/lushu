# Jev 试点标注格式

`samples.jsonl` 每行一个样本，由 `node scripts/jev/build-labeling-kit.mjs` 生成。**`label` 全部为 `null`，必须由人工填写；脚本和模型都不得代填。**

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定编号，如 `import-gate-001` |
| `task` | `import-gate` / `poi-duplicate` / `geocode-choice` |
| `source` | `seed-catalog`（来自仓库内种子 POI）或 `synthetic`（模板文本，不含任何营业时间/价格/地址等事实） |
| `synthetic` | `true` 时，该样本上的准确率不能当作真实场景准确率 |
| `state` | 发送给 Jev 的内容（已去除个人信息） |
| `request` | 发给 Jev 的问题（原顺序 + 打乱顺序）；`geocode-choice` 在补齐候选前为 `null` |
| `repoRelation` | 仅 `poi-duplicate`：仓库里的现有关系（`listed-as-alias` / `distinct-seed-entries`），是参考提示，**不是标签** |
| `candidates` / `needsData` | 仅 `geocode-choice`：AMap 候选需在试点时采集补齐 |
| `label` | 人工标签，见下 |

## `label` 写法

```jsonc
// import-gate
{ "usable": true, "is_shell_page": false, "is_commercial": false,
  "city_match": "matches_selected_city", "detail_level": 2,
  "annotator": "A1", "notes": "" }

// poi-duplicate   link_state: 0=两个不同地点 1=相关但可能不是同一个 2=同一个地点的不同叫法
{ "link_state": 2, "part_of": false, "annotator": "A1", "notes": "" }

// geocode-choice  pick: 候选键（c_0…c_n）或 "none_match"
{ "pick": "c_0", "annotator": "A1", "notes": "" }
```

- 拿不准就不要填（保留 `null`），在 `notes` 里写原因的话可以填 `{"notes": "..."}` 且不给决策字段，评测时会被计为未标注。
- 建议每条至少两人独立标注，分歧由第三人裁决；把裁决结果写入最终 `label`。
- 评测：`node scripts/jev/eval-labels.mjs --labels samples.jsonl --answers answers.jsonl`，或对本地 mock 运行 `--run --url http://127.0.0.1:5499/v1/systemone`。

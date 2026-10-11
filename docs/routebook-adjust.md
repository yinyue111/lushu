# 路书生成后调整

实现方案见 `/workspace/lushu-ui-audit/ux-eval/路书生成后调整方案.md`。本页为代码索引。

## 能力分层

| 层 | 入口 | 配额 |
|----|------|------|
| L1 轻量 | 调整条：规则重排、加减站、换店、删/并天、交通、撤销、去补充站 | 不扣 |
| L2 局部 AI | 「AI 重排本日」或对话触发 → `POST .../patch/propose` → 确认 apply | 局部配额（默认 2× 全日） |
| L3 对话 | 「跟我说」→ 意图确认 → 调 L1/L2/L4 | 按背后动作 |
| L4 整本 | 「整本重生成」→ Builder，文案警示 | 完整生成次数 |

## 关键文件

- `src/lib/routebookAdjust.js` / `adjustIntents.js`
- `src/components/Route/useRoutebookActions.js`
- `src/components/Route/{ReplaceStopDialog,AdjustChatSheet,PatchProposalDialog}.jsx`
- `server/routes/poi.mjs` `GET /api/pois/search`
- `server/ai/patchRoutebook.mjs` + `POST .../patch/propose|apply`
- 行中写回：`TripView` `onAdoptTrip`

## 编辑权

仅草稿 + 所有者（`canEditRoutebook`）。已发布请另存/定制。

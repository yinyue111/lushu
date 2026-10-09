# 境内模型服务接入（OpenAI 兼容）

服务端只依赖 OpenAI 兼容接口，换成境内模型只改环境变量，不改代码。**选哪家、是否已备案，需要运营方决定并核实**（见 `lushu-ui-audit/合规决策清单.md`）。

## 配置项

| 变量 | 说明 |
| --- | --- |
| `AI_PROVIDER` | 服务商标识，只用于日志与成本统计，例如 `qwen`、`deepseek`、`doubao`、`zhipu` |
| `AI_PROVIDER_REGION` | `domestic` / `overseas`。生产环境不是 `domestic` 时启动会打印合规提醒（不阻止启动） |
| `OPENAI_BASE_URL` | 服务商的 OpenAI 兼容根地址，不要带 `/chat/completions` |
| `OPENAI_API_KEY` | 服务商的 API Key，只放服务端 |
| `OPENAI_MODEL` | 模型名或推理接入点 ID |
| `OPENAI_WIRE_API` | 境内服务一般只支持 `chat_completions`；`responses` 仅 OpenAI 系 |

地址拼接规则：根地址以版本段结尾（`/v1`、`/api/v3`、`/api/paas/v4`）时直接拼 `/chat/completions`，否则补 `/v1/chat/completions`（`server/ai/generate.mjs` `openAiEndpoint`，有单测）。

## 示例（地址以服务商官方文档和控制台为准）

```dotenv
# 阿里云百炼（通义千问）兼容模式；新版建议使用业务空间专属域名
AI_PROVIDER=qwen
AI_PROVIDER_REGION=domestic
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_WIRE_API=chat_completions
OPENAI_MODEL=<控制台中的模型名>

# DeepSeek
# OPENAI_BASE_URL=https://api.deepseek.com

# 火山方舟（豆包）：模型填推理接入点 ID
# OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3

# 智谱
# OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
```

## 能力要求与已知差异

- **JSON 输出**：优先发送 `response_format: json_schema`；服务商返回 schema 不支持的 400 时自动退回 `json_object`。仍不支持时生成会失败，需换模型。
- **截图识别（OCR）**：需要支持图片输入的多模态模型；纯文本模型下，上传截图会失败，其余功能不受影响。
- **输出长度**：`AI_MAX_OUTPUT_TOKENS` / `AI_MAX_OUTPUT_TOKENS_RETRY` 需不超过该模型上限。
- **成本统计**：按 `AI_COST_CURRENCY`、`AI_INPUT_COST_PER_MILLION_TOKENS`、`AI_OUTPUT_COST_PER_MILLION_TOKENS` 估算（`server/analytics/aiObservability.mjs`）；换服务商后请按其价目表重新填写（境内服务一般以 CNY 计价），未填写时成本记为不可用，不会猜测。
- 切换后请用 `scripts/eval/run-generation-eval.mjs`（生成质量评测骨架）回归一遍。

## 不在本仓库内完成的事

模型备案或使用已备案模型的证明、与服务商的数据处理协议、数据出境评估，都需要运营方完成，代码无法代替。

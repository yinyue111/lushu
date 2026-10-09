import { formatOpsDate, numberValue } from './OpsShared';

const STAGES = { model: '模型请求与解析', geocoding: '地点坐标解析', routing: '道路核验', persistence: '持久化' };

export function durationLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : '—';
}

export default function AiObservabilityPanel({ summary }) {
  if (!summary) return null;
  const cost = summary.costTotals;
  const metrics = [
    ['生成请求', numberValue(summary.totalCount), `${numberValue(summary.successCount)} 成功 / ${numberValue(summary.failureCount)} 失败`],
    ['超时率', summary.timeoutRate == null ? '—' : `${summary.timeoutRate}%`, `${numberValue(summary.timeoutCount)} / ${numberValue(summary.totalCount)} 请求`],
    ['成功耗时 P95', durationLabel(summary.successfulDurationMs?.p95), `${numberValue(summary.successfulDurationMs?.sampleCount)} 个有效耗时样本`],
    [
      'Token 覆盖率',
      summary.modelUsageCoverage?.rate == null ? '—' : `${summary.modelUsageCoverage.rate}%`,
      `${numberValue(summary.modelUsageCoverage?.reportedCount)} 完整 / ${numberValue(summary.modelUsageCoverage?.partialCount)} 部分`
    ],
    ['已报告 Token', numberValue(summary.tokenTotals?.totalTokens), '仅统计上游实际回传，缺失不估算'],
    [
      '费用估算',
      cost?.amount == null ? '不可用' : `${cost.currency} ${Number(cost.amount).toFixed(4)}`,
      `${numberValue(summary.costCoverage?.estimatedCount)} 个完整 usage + 价格快照样本`
    ]
  ];
  return (
    <section className="ops-panel" aria-labelledby="ai-observability-title">
      <div className="ops-panel-head">
        <div>
          <h2 id="ai-observability-title">AI 运行质量 · 最近 {summary.window?.days || 30} 天</h2>
          <p className="text-caption">
            {formatOpsDate(summary.window?.startAt)} 至 {formatOpsDate(summary.window?.endAt)}，按 requestId 去重。
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {metrics.map(([label, value, note]) => (
          <div className="rounded-card border border-line p-3" key={label}>
            <p className="text-sm text-muted">{label}</p>
            <strong className="mt-1 block text-xl">{value}</strong>
            <p className="mt-1 text-xs text-muted">{note}</p>
          </div>
        ))}
      </div>
      <div className="ops-table-scroll mt-4" tabIndex={0} role="region" aria-label="AI 实测阶段耗时">
        <table className="ops-data-table">
          <thead>
            <tr>
              <th>阶段</th>
              <th>P50</th>
              <th>P95</th>
              <th>样本</th>
              <th>降级 / 失败</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(STAGES).map(([key, label]) => {
              const stage = summary.stages?.[key];
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{durationLabel(stage?.p50)}</td>
                  <td>{durationLabel(stage?.p95)}</td>
                  <td>{numberValue(stage?.sampleCount)}</td>
                  <td>
                    {numberValue(stage?.statusCounts?.degraded)} / {numberValue(stage?.statusCounts?.failed)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        历史记录缺少 usage 或阶段信息时保持不可用。费用仅按运营配置的每百万 Token 单价快照估算，不等于实际账单；不同币种不合并。
      </p>
    </section>
  );
}

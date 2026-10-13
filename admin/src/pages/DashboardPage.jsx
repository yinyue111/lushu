import { adminGet } from '../api';
import { Button, Card, Notice, Page, formatTime, percent, usd, useLoad } from '../ui';

export default function DashboardPage() {
  const { data, error, loading, reload } = useLoad(() => adminGet('/dashboard'));
  const d = data;
  return (
    <Page
      title="概览"
      description="三个数：生成成功率、待确认占比、今日花费。口径见 docs/admin.md。"
      actions={
        <Button onClick={reload} disabled={loading}>
          刷新
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {(d?.warnings ?? []).map((w) => (
        <Notice key={w.key} tone={w.tone}>
          <strong>注意：</strong>
          {w.text}
        </Notice>
      ))}
      {d?.successRate && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="生成成功率（今天）">
            <p className="text-3xl font-semibold">{percent(d.successRate.today.all.rate)}</p>
            <p className="mt-1 text-sm text-muted">
              {d.successRate.today.all.ok}/{d.successRate.today.all.total} 次 · 轻快 {percent(d.successRate.today.fast.rate)} · 细品{' '}
              {percent(d.successRate.today.deep.rate)}
            </p>
            <p className="mt-1 text-sm text-muted">近 7 天 {percent(d.successRate.week.all.rate)}（不含取消、去重和后台试跑）</p>
          </Card>
          <Card title="待确认占比（近 7 天）">
            <p className="text-3xl font-semibold">{percent(d.pendingRatio.ratio)}</p>
            <p className="mt-1 text-sm text-muted">
              {d.pendingRatio.pending}/{d.pendingRatio.stops} 个站点 · {d.pendingRatio.routebooks} 本已核对完的路书
            </p>
          </Card>
          <Card title="今日花费（美元）">
            <p className="text-3xl font-semibold">{d.cost.lowerBound ? `至少 ${usd(d.cost.totalUsd)}` : usd(d.cost.totalUsd)}</p>
            {d.cost.lowerBound && <p className="mt-1 text-sm font-semibold text-warn-ink">另有 {d.cost.unknownCostCount} 次没有单价（没算进上面的金额）</p>}
            <p className="mt-1 text-sm text-muted">
              生成 {usd(d.cost.generationUsd)} · 试跑 {usd(d.cost.testRunUsd)} · 联网补全 {usd(d.cost.enrichUsd)}
            </p>
            <p className="mt-1 text-sm text-muted">
              {d.cost.dailyLimitUsd ? `日上限 ${usd(d.cost.dailyLimitUsd)}，已用 ${percent(d.cost.ratio)}` : '未设日上限'}
            </p>
            <p className="mt-1 text-sm text-muted">上限拦截：{d.cost.cap?.reason ?? '—'}</p>
          </Card>
        </div>
      )}
      {d?.generatedAt && <p className="text-xs text-muted">统计于 {formatTime(d.generatedAt)}</p>}
    </Page>
  );
}

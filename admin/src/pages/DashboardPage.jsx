import { adminGet } from '../api';
import { COST_ESTIMATE_BIAS_HINT, formatCostHeadline, formatCostUnknownNote } from '../costDisplay.js';
import { Button, Card, Notice, Page, formatTime, percent, usd, useLoad } from '../ui';

const JOURNEY_LABELS = [
  ['time_window_set', '设首末日时间窗'],
  ['ai_adjust_apply', '重排或AI微调'],
  ['companion_submit', '同行投票/共记'],
  ['trip_start', '进入行中执行'],
  ['checkin_submit', '提交行中打卡'],
  ['expense_add', '记录AA账单'],
  ['review_export', '导出游记长图/卡片'],
  ['itinerary_print', '导出打印单/日历']
];

export default function DashboardPage() {
  const { data, error, loading, reload } = useLoad(() => adminGet('/dashboard'));
  const d = data;
  return (
    <Page
      title="概览"
      description="今天的成功率、待确认占比和花费。"
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
          {(w.lastSeenAt || w.processLocal) && (
            <span className="mt-1 block text-xs">
              {w.lastSeenAt && `最近一次出现：${formatTime(w.lastSeenAt, { hhmm: true })}`}
              {w.lastSeenAt && w.processLocal && ' · '}
              {w.processLocal && '仅当前进程统计，重启后清零'}
            </span>
          )}
          {w.detail && <span className="mt-1 block text-xs opacity-80">{w.detail}</span>}
          {(w.key === 'open-registration' || /注册当前对所有人开放/.test(String(w.text || ''))) && (
            <a href="/admin/config" className="mt-1 block text-sm font-semibold text-sky-ink underline">
              去设置注册方式或日上限 →
            </a>
          )}
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
            <p className="text-3xl font-semibold">{formatCostHeadline(d.cost)}</p>
            {formatCostUnknownNote(d.cost) ? <p className="mt-1 text-xs text-muted">{formatCostUnknownNote(d.cost)}</p> : null}
            <p className="mt-1 text-xs text-muted">{COST_ESTIMATE_BIAS_HINT}</p>
            <p className="mt-1 text-sm text-muted">
              生成 {usd(d.cost.generationUsd)} · 试跑 {usd(d.cost.testRunUsd)} · 联网核对 {usd(d.cost.enrichUsd)}
            </p>
            <p className="mt-1 text-sm text-muted">
              {d.cost.dailyLimitUsd ? `日上限：${usd(d.cost.dailyLimitUsd)}（已用 ${percent(d.cost.ratio)}）` : '日上限：未设'}
            </p>
          </Card>
        </div>
      )}
      {d?.journeyFunnel && (
        <Card title="近 7 天核心动作触达（行前 → 行中 → 行后）">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {JOURNEY_LABELS.map(([key, label]) => {
              const item = d.journeyFunnel[key] || { people: 0, count: 0 };
              return (
                <div key={key} className="rounded bg-canvas p-2.5">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-0.5 text-lg font-semibold">
                    {item.count} 次 <span className="text-xs font-normal text-muted">（{item.people} 人）</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </Card>
      )}
      {d?.generatedAt && <p className="text-xs text-muted">统计于 {formatTime(d.generatedAt)}</p>}
    </Page>
  );
}

import { CalendarCheck, Copy, FileText, Link2, MousePointerClick, Navigation, TrendingUp } from 'lucide-react';
import { getDashboard, getProductAnalytics } from '../../lib/api';
import { EmptyState, ResourceNotice, firstValue, formatOpsDate, hasValue, numberValue, useOpsResource } from './OpsShared';
import { durationLabel } from './AiObservabilityPanel';

export default function OpsOverview() {
  const dashboardResource = useOpsResource((signal) => getDashboard(1000, signal));
  const analyticsResource = useOpsResource((signal) => getProductAnalytics(500, signal));
  const dashboard = dashboardResource.data?.dashboard ?? null;
  const analytics = analyticsResource.data?.analytics ?? null;
  const funnel = dashboard?.funnel ?? null;
  const dashboardKnown = Boolean(funnel);
  const analyticsKnown = Boolean(analytics);
  const travelDayDefinition = dashboard?.metricDefinitions?.tripDayOpen;

  const metrics = [
    {
      label: '生成成功率',
      icon: Navigation,
      value: rateValue(dashboardKnown, funnel?.generationSuccessRate),
      detail: ratioText(dashboardKnown, funnel?.generatedOk, funnel?.generateAttempts, '次')
    },
    {
      label: '明确保存率',
      icon: FileText,
      // saveRate 口径 = 已保存的生成路书 / 生成路书（见 server/analytics/dashboard.mjs funnel.saveRate）。
      // 分子字段（savedGeneratedRoutebooks）落库前不展示分数，避免与百分比口径矛盾。
      value: rateValue(dashboardKnown, funnel?.saveRate),
      detail:
        dashboardKnown && hasValue(funnel?.savedGeneratedRoutebooks)
          ? ratioText(dashboardKnown, funnel.savedGeneratedRoutebooks, funnel?.generatedRoutes, '条')
          : dashboardKnown
            ? '口径：已保存的生成路书 / 生成路书'
            : '数据状态未知'
    },
    {
      label: '出行日打开率',
      icon: CalendarCheck,
      value: rateValue(dashboardKnown, funnel?.tripDayOpenRate),
      detail: ratioText(dashboardKnown, funnel?.savedTripOpenedJourneys, funnel?.travelDateSavedRoutebooks, '条')
    },
    {
      label: '有效执行率',
      icon: TrendingUp,
      value: rateValue(dashboardKnown, funnel?.effectiveExecutionRate),
      detail: ratioText(dashboardKnown, funnel?.effectiveExecutedRoutebooks, funnel?.travelDateSavedRoutebooks, '条')
    },
    {
      label: '首次分享率',
      icon: Copy,
      value: rateValue(dashboardKnown, funnel?.shareRate),
      detail: ratioText(dashboardKnown, funnel?.sharedRoutebooks, funnel?.savedRoutebooks, '条')
    },
    {
      label: '商品 CTR',
      icon: MousePointerClick,
      value: rateValue(analyticsKnown || dashboardKnown, firstValue(analytics?.overallCtr, funnel?.clickThroughRate)),
      detail: analyticsKnown ? `${numberValue(analytics?.totalExposures)} 曝光 / ${numberValue(analytics?.totalClicks)} 点击` : '数据状态未知'
    },
    {
      label: '来源解析率',
      icon: Link2,
      value: rateValue(dashboardKnown, funnel?.importAnalysisSuccessRate),
      detail: ratioText(dashboardKnown, funnel?.importAnalysisSucceeded, funnel?.importAnalysisAttempts, '个来源')
    }
  ];

  return (
    <div className="ops-workspace-stack">
      <ResourceNotice resource={dashboardResource} label="业务看板" />
      <ResourceNotice resource={analyticsResource} label="商品分析" />

      <section aria-labelledby="ops-overview-metrics-title">
        <div className="ops-section-heading">
          <div>
            <h2 id="ops-overview-metrics-title">核心漏斗</h2>
            <p>原有漏斗基于各事件流最近 {dashboard?.metricDefinitions?.legacyCounters?.limit || 1000} 条记录，非固定日期全量；无法读取时显示未知。</p>
          </div>
          {dashboardResource.updatedAt && <span className="ops-updated-at">更新于 {formatOpsDate(dashboardResource.updatedAt)}</span>}
        </div>
        <div className="stats-grid ops-metric-grid">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="stat-card ops-stat">
                <Icon size={20} />
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </div>
            );
          })}
        </div>
        {travelDayDefinition && (
          <p className="ops-definition-note">
            出行日窗口：{travelDayDefinition.timezone} 自然日，计划日前 {travelDayDefinition.windowDaysBefore} 天至计划日后{' '}
            {travelDayDefinition.windowDaysAfter} 天。
          </p>
        )}
      </section>

      <section className="ops-panel" aria-labelledby="ops-retention-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-retention-title">生成体验与留存 · 独立滚动口径</h2>
            <p className="text-caption">
              {formatOpsDate(dashboard?.metricDefinitions?.repeatGeneration?.window?.startAt)} 至{' '}
              {formatOpsDate(dashboard?.metricDefinitions?.repeatGeneration?.window?.endAt)}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricTile
            label="成功生成耗时 P50 / P95"
            value={`${durationLabel(funnel?.generationLatencyMs?.p50)} / ${durationLabel(funnel?.generationLatencyMs?.p95)}`}
            detail={`${numberValue(funnel?.generationLatencyMs?.sampleCount)} 个去重请求样本，缺失耗时不计入`}
          />
          <MetricTile
            label="重复生成率"
            value={rateValue(dashboardKnown, funnel?.repeatGenerationRate)}
            detail={`${ratioText(dashboardKnown, funnel?.repeatGeneratorProfiles, funnel?.generatorProfiles, '人')}；30 天内至少生成 2 条不同路书`}
          />
          <MetricTile
            label="7 日内回访率"
            value={rateValue(dashboardKnown, funnel?.sevenDayReturnRate)}
            detail={`${ratioText(dashboardKnown, funnel?.sevenDayReturnedProfiles, funnel?.eligibleSevenDayProfiles, '人')}；首次生成后 24 小时至 7 天回访，仅完整观察期`}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          以上指标读取全部可用历史后按窗口与稳定身份去重，零分母显示 —。满意度与不可用投诉尚未接入前端采集，当前不展示虚假的 0%。
        </p>
      </section>

      <section className="ops-panel" aria-labelledby="ops-activity-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-activity-title">最近活动</h2>
            <p className="text-caption">生成、保存、打卡、导入和归因事件</p>
          </div>
          <span className="badge badge-blue">{dashboard ? `${dashboard.recentActivity?.length ?? 0} 条` : '—'}</span>
        </div>
        {dashboardResource.status === 'loading' ? (
          <p className="text-caption">正在读取活动记录...</p>
        ) : dashboard?.recentActivity?.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的数据表">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>对象</th>
                  <th>详情</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recentActivity.slice(0, 12).map((item, index) => (
                  <tr key={`${item.type}-${item.title}-${item.createdAt}-${index}`}>
                    <td>
                      <span className="badge badge-blue">{item.type || '动态'}</span>
                    </td>
                    <td>
                      <strong>{item.title || '未命名'}</strong>
                    </td>
                    <td>{item.detail || '—'}</td>
                    <td>{formatOpsDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : dashboardResource.status === 'error' ? null : (
          <EmptyState>暂无真实活动记录。</EmptyState>
        )}
      </section>
    </div>
  );
}

function rateValue(known, value) {
  return known && hasValue(value) && Number.isFinite(Number(value)) ? `${Number(value)}%` : '—';
}

function MetricTile({ label, value, detail }) {
  return (
    <div className="rounded-card border border-line p-3">
      <p className="text-sm text-muted">{label}</p>
      <strong className="mt-1 block text-xl">{value}</strong>
      <p className="mt-2 text-xs text-muted">{detail}</p>
    </div>
  );
}

function ratioText(known, numerator, denominator, unit) {
  if (!known || !hasValue(numerator) || !hasValue(denominator)) return '数据状态未知';
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) return '—';
  return `${Number(numerator)}/${Number(denominator)} ${unit}`;
}

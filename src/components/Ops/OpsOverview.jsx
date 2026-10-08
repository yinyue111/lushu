import { CalendarCheck, Copy, FileText, Link2, MousePointerClick, Navigation, TrendingUp } from 'lucide-react';
import { getDashboard, getProductAnalytics } from '../../lib/api';
import { EmptyState, ResourceNotice, firstValue, formatOpsDate, hasValue, numberValue, useOpsResource } from './OpsShared';

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
            <p>指标按身份与路书去重，无法读取时显示为未知。</p>
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

function ratioText(known, numerator, denominator, unit) {
  if (!known || !hasValue(numerator) || !hasValue(denominator)) return '数据状态未知';
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) return '—';
  return `${Number(numerator)}/${Number(denominator)} ${unit}`;
}

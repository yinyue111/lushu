import { RefreshCw, SearchCheck } from 'lucide-react';
import { getOpsEnrichment } from '../lib/opsApi';
import { EmptyState, ResourceNotice, formatOpsDate, useOpsResource } from './OpsShared';

const STATUS = { queued: '排队', running: '进行中', done: '完成', failed: '失败', skipped: '跳过' };
const FIELD = { price: '门票', hours: '开放时间' };

// 联网核对：只核对景点的门票和开放时间，两个来源一致才显示。这里看队列、花费、缓存和用户报错。
export default function EnrichmentPanel() {
  const resource = useOpsResource((signal) => getOpsEnrichment(signal));
  const data = resource.data?.enrichment;
  const today = data?.spend?.[0];
  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="ops-enrich-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-enrich-title">联网核对</h2>
            <p className="text-caption">登录用户的路书生成后，后台核对景点门票和开放时间；两个独立来源一致才显示，否则保留“待确认”。</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={resource.retry} disabled={resource.status === 'loading'}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={resource} label="联网核对统计" />
        {data && !data.ready?.ready && <EmptyState>没有在运行：{data.ready?.reason || '未开启'}</EmptyState>}
        {data && (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(STATUS).map(([key, label]) => (
                <div key={key}>
                  <dt className="text-meta text-muted">{label}</dt>
                  <dd className="num text-xl font-bold">{data.byStatus?.[key] ?? 0}</dd>
                </div>
              ))}
              <div>
                <dt className="text-meta text-muted">已补上 / 保留待确认</dt>
                <dd className="num text-xl font-bold">
                  {data.filled} / {data.kept}
                </dd>
              </div>
              <div>
                <dt className="text-meta text-muted">今天花费</dt>
                <dd className="num text-xl font-bold">
                  ${(today?.usd ?? 0).toFixed(2)}
                  {data.dailyBudgetUsd ? <small className="ml-1 text-meta text-muted">/ ${data.dailyBudgetUsd} 预算</small> : null}
                </dd>
              </div>
              <div>
                <dt className="text-meta text-muted">今天搜索 / 抓页面 / 高德</dt>
                <dd className="num text-xl font-bold">
                  {today?.searches ?? 0} / {today?.pages ?? 0} / {today?.amapCalls ?? 0}
                </dd>
              </div>
              <div>
                <dt className="text-meta text-muted">缓存条目</dt>
                <dd className="num text-xl font-bold">{data.cacheEntries}</dd>
              </div>
            </dl>
            <h3 className="mt-4 font-bold">近 7 天</h3>
            {data.spend?.length ? (
              <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="近 7 天花费，可横向滚动">
                <table className="ops-data-table">
                  <thead>
                    <tr>
                      <th>日期（UTC）</th>
                      <th>花费</th>
                      <th>搜索</th>
                      <th>抓页面</th>
                      <th>高德</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.spend.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td className="num">${Number(row.usd).toFixed(2)}</td>
                        <td className="num">{row.searches}</td>
                        <td className="num">{row.pages}</td>
                        <td className="num">{row.amapCalls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>还没有花费。</EmptyState>
            )}
            <h3 className="mt-4 font-bold">用户报错（共 {data.reports} 条）</h3>
            {data.recentReports?.length ? (
              <ul className="flex list-none flex-col gap-2 p-0 text-sm">
                {data.recentReports.map((report) => (
                  <li key={report.id}>
                    <strong>{FIELD[report.field] ?? report.field}</strong> · 路书 {report.routebookId} · 站点 {report.stopKey}
                    {report.note && <span> · “{report.note}”</span>}
                    <small> {formatOpsDate(report.createdAt)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>
                <SearchCheck size={14} aria-hidden="true" /> 还没有用户报错。
              </EmptyState>
            )}
          </>
        )}
      </section>
    </div>
  );
}

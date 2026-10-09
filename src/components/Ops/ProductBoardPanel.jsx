import { MousePointerClick, RefreshCw, Ticket } from 'lucide-react';
import { getProductAnalytics } from '../../lib/api';
import { EmptyState, ResourceNotice, firstValue, formatOpsDate, hasValue, numberValue, textValue, useOpsResource } from './OpsShared';

// OTA 商品点击看板：只读渲染 /api/product-analytics 聚合结果。
// 服务端字段见 server/analytics/dashboard.mjs buildProductAnalytics：ctrByProduct/byRoute/byProvider/byType/recentClicks。
export default function ProductBoardPanel() {
  const analyticsResource = useOpsResource((signal) => getProductAnalytics(500, signal));
  const analytics = analyticsResource.data?.analytics ?? null;
  const analyticsReady = analyticsResource.status === 'ready' || analyticsResource.status === 'empty' || analyticsResource.status === 'refreshing';
  const ctrRows = asArray(analytics?.ctrByProduct);
  const recentClicks = asArray(analytics?.rawRecentClicks);

  return (
    <div className="ops-workspace-stack">
      <section aria-labelledby="product-board-title">
        <div className="ops-section-heading">
          <div>
            <h2 id="product-board-title">OTA 商品点击看板</h2>
            <p>CTR 只统计能与同会话曝光严格匹配的点击；原始及历史未归因流水单独保留。</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={analyticsResource.retry} disabled={analyticsResource.status === 'loading'}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={analyticsResource} label="商品分析" />
        <div className="stats-grid ops-content-stats">
          <BoardStat label="可归因曝光" value={numberValue(analytics?.totalExposures)} />
          <BoardStat label="去重归因点击" value={numberValue(analytics?.totalClicks)} />
          <BoardStat label="匹配 CTR" value={overallCtrDisplay(analytics)} />
          <BoardStat label="原始点击" value={numberValue(analytics?.rawClickCount)} />
          <BoardStat label="未归因点击" value={numberValue(analytics?.unattributedClickCount)} />
          <BoardStat label="历史重复点击" value={numberValue(analytics?.duplicateClickCount)} />
        </div>
        {analytics && (
          <p className="text-caption">
            {analytics.metricDefinition} 统计范围：全部已持久化事件；原始曝光 {numberValue(analytics.rawExposureCount)} 条，其中{' '}
            {numberValue(analytics.unattributedExposureCount)} 条缺少关联凭据。
          </p>
        )}
      </section>

      <section className="ops-panel" aria-labelledby="product-funnel-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="product-funnel-title">商品归因漏斗</h2>
            <p className="text-caption">每个曝光标识最多计一次点击，按 POI、路线、达人定位转化差异。</p>
          </div>
        </div>
        <div className="stats-grid ops-metric-grid">
          <FunnelTable title="按 POI" rows={asArray(analytics?.funnelByPoi)} />
          <FunnelTable title="按路线" rows={asArray(analytics?.funnelByRoute)} />
          <FunnelTable title="按达人" rows={asArray(analytics?.funnelByCreator)} />
        </div>
      </section>

      <section className="ops-panel" aria-labelledby="product-ctr-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="product-ctr-title">商品 CTR 明细</h2>
            <p className="text-caption">按商品聚合曝光 / 点击 / CTR</p>
          </div>
          <span className="badge badge-blue">
            <Ticket size={12} /> {analytics ? `${ctrRows.length} 个商品` : '—'}
          </span>
        </div>
        {ctrRows.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的数据表">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>曝光</th>
                  <th>点击</th>
                  <th>CTR</th>
                </tr>
              </thead>
              <tbody>
                {ctrRows.map((row, index) => (
                  <tr key={row.key || `${row.label}-${index}`}>
                    <td>
                      <strong>{textValue(row.label || row.key)}</strong>
                      {row.key && row.key !== row.label && <small>{row.key}</small>}
                    </td>
                    <td>{numberValue(row.exposureCount)}</td>
                    <td>{numberValue(row.clickCount)}</td>
                    <td>{hasValue(row.ctr) && Number.isFinite(Number(row.ctr)) ? `${Number(row.ctr)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : analyticsReady ? (
          <EmptyState>暂无商品曝光数据。商品卡在路线页产生曝光后，这里会出现 CTR 明细。</EmptyState>
        ) : null}
      </section>

      <section className="ops-panel" aria-labelledby="product-groups-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="product-groups-title">点击分组</h2>
            <p className="text-caption">按路线、供应商、商品类型聚合点击次数</p>
          </div>
        </div>
        <div className="stats-grid ops-metric-grid">
          <GroupTable title="按路线" rows={asArray(analytics?.byRoute)} ready={analyticsReady} />
          <GroupTable title="按供应商" rows={asArray(analytics?.byProvider)} ready={analyticsReady} />
          <GroupTable title="按商品类型" rows={asArray(analytics?.byType)} ready={analyticsReady} />
        </div>
      </section>

      <section className="ops-panel" aria-labelledby="product-recent-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="product-recent-title">最近点击流水</h2>
            <p className="text-caption">最近 20 条原始流水，未归因数据不进入 CTR</p>
          </div>
          <span className="badge badge-blue">
            <MousePointerClick size={12} /> {analytics ? `${recentClicks.length} 条` : '—'}
          </span>
        </div>
        {recentClicks.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的数据表">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>商品</th>
                  <th>路线</th>
                  <th>来源</th>
                  <th>归因状态</th>
                </tr>
              </thead>
              <tbody>
                {recentClicks.map((click, index) => (
                  <tr key={click.id || `${click.productId}-${click.createdAt}-${index}`}>
                    <td>{formatOpsDate(click.createdAt)}</td>
                    <td>
                      <strong>{textValue(firstValue(click.productTitle, click.productId))}</strong>
                      {isSeedFallbackClick(click) && <span className="badge badge-orange">seed-fallback</span>}
                    </td>
                    <td>{textValue(firstValue(click.routeTitle, click.routeId))}</td>
                    <td>
                      {textValue(firstValue(click.source, click.sourcePosition))}
                      {click.sourcePosition && click.source ? ` · ${click.sourcePosition}` : ''}
                    </td>
                    <td>{click.attributionStatus === 'attributed' ? '已匹配曝光' : click.attributionStatus === 'duplicate' ? '重复，未计入CTR' : '未归因'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : analyticsReady ? (
          <EmptyState>暂无商品点击流水。用户点击路线页或 POI 详情里的商品卡后会出现在这里。</EmptyState>
        ) : null}
      </section>
    </div>
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// seed 兜底点击：优先读服务端归因标记 analyticsSource:'seed-fallback'，
// 其次 linkType:'seed-search'；两者都缺失的老数据才退化为按种子商品 ID 前缀识别。
function isSeedFallbackClick(click) {
  if (click?.analyticsSource === 'seed-fallback') return true;
  if (click?.linkType === 'seed-search') return true;
  const productId = String(click?.productId ?? '');
  return productId.startsWith('seed-product') || productId.startsWith('seed-');
}

function overallCtrDisplay(analytics) {
  const value = analytics?.overallCtr;
  return value != null && Number.isFinite(Number(value)) ? String(value) + '%' : '—';
}

function FunnelTable({ title, rows }) {
  return (
    <div className="card-flat p-3">
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      {rows.length ? (
        <table className="ops-data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>曝光</th>
              <th>点击</th>
              <th>CTR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{row.exposureCount}</td>
                <td>{row.clickCount}</td>
                <td>{row.ctr}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-caption">暂无可归因曝光。</p>
      )}
    </div>
  );
}

function BoardStat({ label, value }) {
  return (
    <div className="ops-content-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GroupTable({ title, rows, ready }) {
  return (
    <div className="card-flat" style={{ padding: 14 }}>
      <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>
        {title}
      </h3>
      {rows.length ? (
        <table className="ops-data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>点击</th>
              <th>最近点击</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, index) => (
              <tr key={row.key || `${row.label}-${index}`}>
                <td>{textValue(row.label || row.key)}</td>
                <td>{numberValue(row.count)}</td>
                <td>{formatOpsDate(row.lastClickedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : ready ? (
        <p className="text-caption">暂无点击数据。</p>
      ) : (
        <p className="text-caption">读取中或暂不可用。</p>
      )}
    </div>
  );
}

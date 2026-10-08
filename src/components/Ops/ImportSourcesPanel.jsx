import { useState } from 'react';
import { Filter, Link2, RefreshCw } from 'lucide-react';
import { getImports } from '../../lib/api';
import { EmptyState, ResourceNotice, firstValue, formatOpsDate, hasValue, numberValue, textValue, useOpsResource } from './OpsShared';

const STATUS_FILTERS = [
  { id: 'all', label: '全部状态' },
  { id: 'fetched', label: '抓取成功' },
  { id: 'metadata-only', label: '仅元数据' },
  { id: 'failed', label: '抓取失败' }
];

// 攻略来源管理（只读 V1）：列出 /api/imports 的导入分析记录，按来源逐行展开。
// 「提取 POI 数」「关联 routebook」为防御式读取——当前导入日志尚未落这两个字段，
// 缺失时显示为 —，待服务端补齐后自动出现。
export default function ImportSourcesPanel() {
  const importsResource = useOpsResource((signal) => getImports(100, signal));
  const [statusFilter, setStatusFilter] = useState('all');
  const rows = flattenImportSources(importsResource.data);
  const visibleRows = statusFilter === 'all' ? rows : rows.filter((row) => row.status === statusFilter);
  const listReady = ['ready', 'empty', 'refreshing'].includes(importsResource.status);

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="import-sources-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="import-sources-title">攻略来源管理</h2>
            <p className="text-caption">导入分析记录：来源抓取状态、可信分与风险提示</p>
          </div>
          <span className="badge badge-blue"><Link2 size={12} /> {importsResource.data ? `${visibleRows.length} 个来源` : '—'}</span>
        </div>
        <div className="ops-filter-bar" aria-label="来源筛选">
          <Filter size={15} aria-hidden="true" />
          <label>
            <span>抓取状态</span>
            <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {STATUS_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={importsResource.retry} disabled={importsResource.status === 'loading'}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={importsResource} label="导入分析记录" />
        {visibleRows.length ? (
          <div className="ops-table-scroll">
            <table className="ops-data-table">
              <thead>
                <tr><th>时间</th><th>来源</th><th>状态</th><th>可信分</th><th>提取 POI</th><th>关联路书</th><th>风险提示</th></tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.key}>
                    <td>{formatOpsDate(row.createdAt)}</td>
                    <td>
                      <strong>{textValue(firstValue(row.title, row.platform))}</strong>
                      {row.url ? (
                        <small>
                          <a href={row.url} target="_blank" rel="noreferrer" className="ops-table-link">{shortenUrl(row.url)}</a>
                        </small>
                      ) : row.platform ? <small>{row.platform}</small> : null}
                    </td>
                    <td><SourceStatusBadge value={row.status} /></td>
                    <td>{numberValue(row.trustScore)}</td>
                    <td>{numberValue(row.poiCount)}</td>
                    <td>{textValue(firstValue(row.routebookTitle, row.routebookId))}</td>
                    <td>{row.warnings.length ? row.warnings.slice(0, 2).join('；') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : listReady ? (
          <EmptyState>
            {rows.length
              ? '当前筛选状态下没有导入来源。'
              : '导入分析尚无记录。用户在生成页粘贴攻略链接并解析后，会在这里出现来源明细。'}
          </EmptyState>
        ) : null}
        <p className="text-caption" style={{ marginTop: 10 }}>
          状态口径与看板「来源解析率」一致：fetched 计成功，metadata-only 与 failed 计失败。
        </p>
      </section>
    </div>
  );
}

function flattenImportSources(data) {
  const records = Array.isArray(data?.imports) ? data.imports : [];
  return records.flatMap((record, recordIndex) => {
    const recordId = record?.id || `import-${recordIndex}`;
    const sources = Array.isArray(record?.sources) ? record.sources : [];
    if (!sources.length) {
      return [{
        key: recordId,
        createdAt: record?.createdAt,
        url: '',
        platform: '',
        title: '导入记录（无来源明细）',
        status: '',
        trustScore: record?.averageTrust,
        warnings: [],
        poiCount: firstValue(record?.poiCount, record?.extractedPoiCount),
        routebookId: firstValue(record?.routebookId, record?.routeId),
        routebookTitle: firstValue(record?.routebookTitle, record?.routeTitle)
      }];
    }
    return sources.map((source, index) => ({
      key: `${recordId}-${index}`,
      createdAt: firstValue(source?.fetchedAt, record?.createdAt),
      url: safeHttpUrl(source?.url),
      platform: textOrEmpty(source?.platform),
      title: textOrEmpty(source?.title),
      status: String(source?.status ?? ''),
      trustScore: source?.trustScore,
      warnings: Array.isArray(source?.warnings) ? source.warnings.filter(Boolean).map(String) : [],
      poiCount: firstValue(source?.poiCount, source?.extractedPoiCount, record?.poiCount, record?.extractedPoiCount),
      routebookId: firstValue(source?.routebookId, record?.routebookId, record?.routeId),
      routebookTitle: firstValue(record?.routebookTitle, record?.routeTitle)
    }));
  });
}

function safeHttpUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function textOrEmpty(value) {
  return hasValue(value) ? String(value) : '';
}

function shortenUrl(url) {
  return url.length > 56 ? `${url.slice(0, 56)}…` : url;
}

function SourceStatusBadge({ value }) {
  const presentation = {
    fetched: ['抓取成功', 'badge-green'],
    'metadata-only': ['仅元数据', 'badge-orange'],
    failed: ['抓取失败', 'badge-red']
  }[String(value ?? '')] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}

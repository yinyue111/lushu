import { useState } from 'react';
import { CheckCircle2, Database, FileCheck2, FileUp, Filter, Pencil, RefreshCw } from 'lucide-react';
import { getPoiCoverage, getPois, upsertPois, validatePois } from '../../lib/api';
import PoiEditorDrawer from './PoiEditorDrawer';
import { EmptyState, ResourceNotice, firstValue, formatApiError, formatOpsDate, hasValue, numberValue, textValue, useOpsResource } from './OpsShared';

const TRUSTED_CITIES = ['杭州', '上海', '苏州'];
const MAX_IMPORT_FILE_BYTES = 750 * 1024;

export default function PoiContentPanel() {
  const [filters, setFilters] = useState({ city: '', reviewStatus: '', freshnessState: '' });
  const coverageResource = useOpsResource((signal) => getPoiCoverage(signal));
  const poisResource = useOpsResource(
    (signal) => getPois({ ...filters, limit: 200 }, signal),
    { dependencies: [filters.city, filters.reviewStatus, filters.freshnessState] }
  );
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [validation, setValidation] = useState({ status: 'idle', data: null, error: null });
  const [commit, setCommit] = useState({ status: 'idle', data: null, error: null });
  const [editingPoi, setEditingPoi] = useState(null);

  const coverage = normalizeCoverage(coverageResource.data);
  const pois = normalizePois(poisResource.data);
  const validationRows = Array.isArray(validation.data?.rows) ? validation.data.rows : [];
  const canCommit = validation.status === 'ready' && validation.data?.canCommit === true &&
    Boolean(validation.data?.batchId) && Boolean(validation.data?.commitToken);
  const importSummary = validation.data?.summary ?? null;

  async function handleFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFileError('');
    if (!/\.(json|jsonl)$/i.test(file.name)) {
      setFileError('仅支持 .json 或 .jsonl 文件');
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setFileName('');
      setFileError(`文件过大（${formatFileSize(file.size)}），单次最多导入 750 KB`);
      return;
    }
    try {
      const text = await file.text();
      updateContent(text);
      setFileName(file.name);
    } catch (error) {
      setFileError(error.message || '文件读取失败');
    }
  }

  function updateContent(value) {
    setContent(value);
    setValidation({ status: 'idle', data: null, error: null });
    setCommit({ status: 'idle', data: null, error: null });
  }

  async function handleValidate() {
    if (!content.trim()) return;
    setValidation({ status: 'loading', data: null, error: null });
    setCommit({ status: 'idle', data: null, error: null });
    try {
      const data = await validatePois(content);
      setValidation({ status: 'ready', data, error: null });
    } catch (error) {
      setValidation({ status: 'error', data: null, error });
    }
  }

  async function handleCommit() {
    if (!canCommit) return;
    setCommit({ status: 'loading', data: null, error: null });
    try {
      const data = await upsertPois({
        content,
        batchId: validation.data.batchId,
        commitToken: validation.data.commitToken
      });
      setCommit({ status: 'ready', data, error: null });
      coverageResource.retry();
      poisResource.retry();
    } catch (error) {
      setCommit({ status: 'error', data: null, error });
    }
  }

  return (
    <div className="ops-workspace-stack">
      <section aria-labelledby="poi-coverage-title">
        <div className="ops-section-heading">
          <div>
            <h2 id="poi-coverage-title">三城内容覆盖</h2>
            <p>杭州、上海、苏州的 POI、事实、证据与新鲜度。</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={coverageResource.retry} disabled={coverageResource.status === 'loading'}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={coverageResource} label="内容覆盖" />
        <div className="stats-grid ops-content-stats">
          <CoverageStat label="POI 总数" value={coverageValue(coverage.totals, ['poiCount', 'totalPois', 'total'])} />
          <CoverageStat label="事实完整" value={coverageRate(coverage.totals, ['verifiedCoveragePercent', 'factCoverageRate', 'requiredFactCoverageRate', 'completeFactRate'], ['verifiedPois', 'completePoiCount', 'completeFacts'])} />
          <CoverageStat label="有效证据" value={coverageRate(coverage.totals, ['evidenceCoveragePercent', 'evidenceCoverageRate', 'approvedEvidenceRate'], ['evidenceBackedPois', 'evidenceCount', 'approvedEvidenceCount'])} />
          <CoverageStat label="已过期事实" tone="danger" value={coverageValue(coverage.totals, ['staleFacts', 'staleFactCount', 'expiredFactCount', 'stale'])} />
          <CoverageStat label="待审核" tone="warning" value={coverageValue(coverage.totals, ['pendingReview', 'pendingReviewCount', 'pendingCount', 'pending'])} />
        </div>
        {coverage.cities.length ? (
          <div className="ops-table-scroll">
            <table className="ops-data-table ops-coverage-table">
              <thead>
                <tr><th>城市</th><th>POI</th><th>事实完整</th><th>有效证据</th><th>新鲜</th><th>临期</th><th>过期</th><th>待审</th></tr>
              </thead>
              <tbody>
                {coverage.cities.map((item) => (
                  <tr key={item.city}>
                    <td><button className="ops-table-link" type="button" onClick={() => setFilters((previous) => ({ ...previous, city: item.city }))}>{item.city}</button></td>
                    <td>{coverageValue(item, ['poiCount', 'totalPois', 'total'])}</td>
                    <td>{coverageRate(item, ['verifiedCoveragePercent', 'factCoverageRate', 'requiredFactCoverageRate'], ['verifiedPois', 'completePoiCount', 'completeFacts'])}</td>
                    <td>{coverageRate(item, ['evidenceCoveragePercent', 'evidenceCoverageRate', 'approvedEvidenceRate'], ['evidenceBackedPois', 'evidenceCount', 'approvedEvidenceCount'])}</td>
                    <td>{coverageValue(item, ['freshFacts', 'freshFactCount', 'freshCount', 'fresh'])}</td>
                    <td>{coverageValue(item, ['expiringSoonFacts', 'expiringFactCount', 'expiringCount', 'expiring'])}</td>
                    <td className="ops-cell-danger">{coverageValue(item, ['staleFacts', 'staleFactCount', 'expiredFactCount', 'stale'])}</td>
                    <td>{coverageValue(item, ['pendingReview', 'pendingReviewCount', 'pendingCount', 'pending'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : coverageResource.status === 'ready' || coverageResource.status === 'empty' ? (
          <EmptyState>尚无城市覆盖数据。</EmptyState>
        ) : null}
      </section>

      <section className="ops-panel" aria-labelledby="poi-inventory-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="poi-inventory-title">POI 库存</h2>
            <p className="text-caption">按城市、审核状态和事实新鲜度筛选</p>
          </div>
          <span className="badge badge-blue">{poisResource.data ? `${pois.length} 条` : '—'}</span>
        </div>
        <div className="ops-filter-bar" aria-label="POI 筛选">
          <Filter size={15} aria-hidden="true" />
          <label>
            <span>城市</span>
            <select className="input-field" value={filters.city} onChange={(event) => setFilters((previous) => ({ ...previous, city: event.target.value }))}>
              <option value="">全部城市</option>
              {TRUSTED_CITIES.map((city) => <option key={city} value={city}>{city}</option>)}
            </select>
          </label>
          <label>
            <span>审核状态</span>
            <select className="input-field" value={filters.reviewStatus} onChange={(event) => setFilters((previous) => ({ ...previous, reviewStatus: event.target.value }))}>
              <option value="">全部状态</option>
              <option value="pending">待审核</option>
              <option value="approved">已通过</option>
              <option value="rejected">已驳回</option>
            </select>
          </label>
          <label>
            <span>新鲜度</span>
            <select className="input-field" value={filters.freshnessState} onChange={(event) => setFilters((previous) => ({ ...previous, freshnessState: event.target.value }))}>
              <option value="">全部新鲜度</option>
              <option value="fresh">新鲜</option>
              <option value="expiringSoon">临期</option>
              <option value="stale">已过期</option>
              <option value="pending">待核验</option>
            </select>
          </label>
        </div>
        <ResourceNotice resource={poisResource} label="POI 库存" />
        {pois.length ? (
          <div className="ops-table-scroll">
            <table className="ops-data-table">
              <thead><tr><th>城市</th><th>POI</th><th>事实</th><th>证据</th><th>新鲜度</th><th>审核</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                {pois.map((poi, index) => (
                  <tr key={poi.id || `${poi.city}-${poi.name}-${index}`}>
                    <td>{textValue(poi.city)}</td>
                    <td><strong>{textValue(poi.name)}</strong>{poi.poiId && <small>{poi.poiId}</small>}</td>
                    <td>{countCollection(poi.facts, firstValue(poi.factCount, poi.factsCount))}</td>
                    <td>{countCollection(poi.evidence, firstValue(poi.evidenceCount, poi.approvedEvidenceCount))}</td>
                    <td><FreshnessBadge value={poi.freshnessState} /></td>
                    <td><ReviewBadge value={poi.reviewStatus} /></td>
                    <td>{formatOpsDate(firstValue(poi.updatedAt, poi.reviewedAt, poi.createdAt))}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setEditingPoi(poi)}>
                        <Pencil size={13} /> 查看/编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : poisResource.status === 'ready' || poisResource.status === 'empty' ? (
          <EmptyState>当前筛选条件下没有 POI。</EmptyState>
        ) : null}
      </section>

      <section className="ops-panel" aria-labelledby="poi-import-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="poi-import-title">批量导入</h2>
            <p className="text-caption">先校验，确认无误后再写入内容库</p>
          </div>
          <span className="badge badge-blue"><Database size={12} /> dry-run</span>
        </div>
        <div className="ops-import-toolbar">
          <label className="btn btn-secondary btn-sm ops-file-button">
            <FileUp size={14} /> 选择 JSON / JSONL
            <input className="sr-only" type="file" accept=".json,.jsonl,application/json,application/x-ndjson" onChange={handleFile} />
          </label>
          {fileName && <span className="text-caption">{fileName}</span>}
          {fileError && <span className="text-caption ops-error-text" role="alert">{fileError}</span>}
        </div>
        <label>
          <span className="input-label">导入内容</span>
          <textarea
            className="input-field ops-import-editor"
            value={content}
            onChange={(event) => updateContent(event.target.value)}
            placeholder={'{"city":"杭州","name":"示例 POI","facts":[],"evidence":[]}'}
            spellCheck="false"
          />
        </label>
        <div className="ops-inline-actions ops-import-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={handleValidate} disabled={!content.trim() || validation.status === 'loading'}>
            <FileCheck2 size={14} /> {validation.status === 'loading' ? '校验中...' : '校验内容'}
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={handleCommit} disabled={!canCommit || commit.status === 'loading'}>
            <CheckCircle2 size={14} /> {commit.status === 'loading' ? '写入中...' : '确认写入'}
          </button>
        </div>
        <div className="ops-live-message" role="status" aria-live="polite" aria-atomic="true">
          {validation.status === 'error' && <span className="ops-error-text">校验失败：{formatApiError(validation.error)}</span>}
          {validation.status === 'ready' && (
            <span>{validation.data.canCommit ? '校验通过，可以写入。' : '校验未通过，请修正错误行。'} 批次 {validation.data.batchId || '—'}</span>
          )}
          {commit.status === 'error' && <span className="ops-error-text">写入失败：{formatApiError(commit.error)}</span>}
          {commit.status === 'ready' && (
            <span>{commit.data?.replayed ? '该批次已写入，本次返回幂等结果。' : '批量写入完成。'} {summaryText(commit.data?.summary)}</span>
          )}
        </div>
        {importSummary && <ImportSummary summary={importSummary} />}
        {validationRows.length > 0 && <ValidationPreview rows={validationRows} />}
      </section>

      {editingPoi && (
        <PoiEditorDrawer
          key={editingPoi.poiId || editingPoi.id}
          poi={editingPoi}
          onClose={() => setEditingPoi(null)}
          onSaved={() => {
            coverageResource.retry();
            poisResource.retry();
          }}
        />
      )}
    </div>
  );
}

function normalizeCoverage(data) {
  const payload = data?.coverage ?? data ?? {};
  const sourceCities = Array.isArray(payload.cities) ? payload.cities : [];
  const byCity = sourceCities.map((item) => ({ ...item, city: item.city || item.name })).filter((item) => item.city);
  return { cities: byCity, totals: payload.totals ?? payload.total ?? null };
}

function normalizePois(data) {
  const rows = data?.pois ?? data?.items ?? data?.rows ?? [];
  return Array.isArray(rows) ? rows.map((item) => ({
    ...item,
    id: item.id || item.poiId,
    poiId: item.poiId || item.id,
    name: item.name || item.stopName || item.title,
    reviewStatus: item.reviewStatus || item.status,
    freshnessState: item.freshnessState || item.freshness?.state
  })) : [];
}

function CoverageStat({ label, value, tone = '' }) {
  return (
    <div className={`ops-content-stat ${tone ? `is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function coverageValue(source, keys) {
  if (!source) return '—';
  return numberValue(firstValue(...keys.map((key) => source[key])));
}

function coverageRate(source, rateKeys, countKeys) {
  if (!source) return '—';
  const explicitRateKey = rateKeys.find((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (explicitRateKey) {
    const rate = source[explicitRateKey];
    return hasValue(rate) && Number.isFinite(Number(rate)) ? `${Number(rate)}%` : '—';
  }
  return numberValue(firstValue(...countKeys.map((key) => source[key])));
}

function formatFileSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function countCollection(collection, fallback) {
  if (Array.isArray(collection)) return collection.length;
  return numberValue(fallback);
}

function FreshnessBadge({ value }) {
  const normalized = String(value || '').toLowerCase();
  const presentation = {
    fresh: ['新鲜', 'badge-green'],
    expiringsoon: ['临期', 'badge-orange'],
    expiring: ['临期', 'badge-orange'],
    stale: ['已过期', 'badge-red'],
    expired: ['已过期', 'badge-red'],
    pending: ['待核验', 'badge-blue'],
    missing: ['未设置', 'badge-blue']
  }[normalized] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}

function ReviewBadge({ value }) {
  const normalized = String(value || '').toLowerCase();
  const presentation = {
    pending: ['待审核', 'badge-orange'],
    approved: ['已通过', 'badge-green'],
    rejected: ['已驳回', 'badge-red']
  }[normalized] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}

function ImportSummary({ summary }) {
  const metrics = [
    ['总行数', firstValue(summary.totalRows, summary.total, summary.rowCount)],
    ['新增', firstValue(summary.new, summary.createCount, summary.created, summary.create)],
    ['更新', firstValue(summary.updateCount, summary.updated, summary.update)],
    ['无变化', firstValue(summary.unchangedCount, summary.unchanged, summary.noop)],
    ['冲突', firstValue(summary.conflict, summary.conflictCount, summary.conflicts)],
    ['错误', firstValue(summary.error, summary.invalidCount, summary.errorCount, summary.invalid, summary.errors)]
  ].filter(([, value]) => hasValue(value) && Number.isFinite(Number(value)));
  if (!metrics.length) return null;
  return (
    <div className="ops-import-summary">
      {metrics.map(([label, value]) => <span key={label}><b>{Number(value)}</b>{label}</span>)}
    </div>
  );
}

function ValidationPreview({ rows }) {
  return (
    <div className="ops-table-scroll">
      <table className="ops-data-table">
        <thead><tr><th>行</th><th>动作</th><th>城市</th><th>POI</th><th>校验结果</th></tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const errors = normalizeRowErrors(row);
            const warnings = normalizeRowWarnings(row);
            const action = row.action || row.operation || row.status || (errors.length ? 'invalid' : 'valid');
            const actionTone = errors.length || action === 'conflict' || action === 'error'
              ? 'badge-red'
              : action === 'new' || action === 'create'
                ? 'badge-green'
                : action === 'update'
                  ? 'badge-orange'
                  : 'badge-blue';
            return (
              <tr key={row.rowNumber || row.line || index}>
                <td>{firstValue(row.rowNumber, row.line, index + 1)}</td>
                <td><span className={`badge ${actionTone}`}>{actionLabel(action)}</span></td>
                <td>{textValue(row.normalized?.city || row.city || row.value?.city || row.poi?.city)}</td>
                <td>{textValue(row.normalized?.name || row.name || row.value?.name || row.poi?.name)}</td>
                <td>
                  {errors.length
                    ? <span className="ops-error-text">{errors.join('；')}</span>
                    : warnings.length
                      ? <span>{warnings.join('；')}</span>
                      : '通过'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function normalizeRowErrors(row) {
  const values = Array.isArray(row.errors) ? row.errors : row.error ? [row.error] : [];
  return values.map((item) => typeof item === 'string' ? item : [item.path || item.field, item.message || item.code].filter(Boolean).join('：')).filter(Boolean);
}

function normalizeRowWarnings(row) {
  const values = Array.isArray(row.warnings) ? row.warnings : row.warning ? [row.warning] : [];
  return values.map((item) => typeof item === 'string' ? item : [item.path || item.field, item.message || item.code].filter(Boolean).join('：')).filter(Boolean);
}

function actionLabel(value) {
  return ({ new: '新增', create: '新增', update: '更新', unchanged: '无变化', noop: '无变化', error: '错误', invalid: '错误', valid: '有效', conflict: '冲突' })[value] || value || '有效';
}

function summaryText(summary) {
  if (!summary) return '';
  const count = firstValue(summary.totalRows, summary.total, summary.processed, summary.upserted);
  return hasValue(count) ? `共处理 ${count} 行。` : '';
}

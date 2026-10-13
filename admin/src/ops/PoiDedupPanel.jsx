import { useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent } from '../../../src/components/ui/dialog';
import { getOpsPoiDuplicates, saveOpsPoiMergeDecision } from '../lib/opsApi';
import { EmptyState, ResourceNotice, formatApiError, formatOpsDate, useOpsResource } from './OpsShared';

const CITY_FILTERS = ['', '杭州', '上海', '苏州'];
const MATCH_LABELS = { exact: '同名', alias: '别名/通名一致', contains: '名称包含' };

// 重复 POI 只做「候选」：系统不会自动合并。人工确认后写入追加式决定（含原因、处置人），可撤销。
export default function PoiDedupPanel() {
  const [city, setCity] = useState('');
  const [dialog, setDialog] = useState(null);
  const resource = useOpsResource((signal) => getOpsPoiDuplicates(city, signal), {
    dependencies: [city],
    isEmpty: (data) => !data?.candidates?.length && !data?.merges?.length
  });
  const candidates = resource.data?.candidates ?? [];
  const merges = resource.data?.merges ?? [];
  const listReady = ['ready', 'empty', 'refreshing'].includes(resource.status);
  const poiLabel = (poi) => `${poi.name}（${poi.poiId}）`;

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="poi-dedup-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="poi-dedup-title">重复 POI 复核</h2>
            <p className="text-caption">按名称规则与距离给出疑似重复，仅供人工判断；合并后可随时撤销，所有决定保留原因与处置人</p>
          </div>
          <span className="badge badge-blue">
            <GitMerge size={12} /> {resource.data ? `${candidates.length} 对待复核` : '—'}
          </span>
        </div>
        <div className="ops-filter-bar" aria-label="重复 POI 筛选">
          <label>
            <span>城市</span>
            <select className="input-field" value={city} onChange={(event) => setCity(event.target.value)}>
              {CITY_FILTERS.map((item) => (
                <option key={item || 'all'} value={item}>
                  {item || '全部城市'}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={resource.retry} disabled={resource.status === 'loading'}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={resource} label="重复 POI 候选" />
        {candidates.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="疑似重复 POI，可横向滚动">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>城市</th>
                  <th>POI A</th>
                  <th>POI B</th>
                  <th>依据</th>
                  <th>距离</th>
                  <th>处置</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.pairKey}>
                    <td>{candidate.city}</td>
                    {candidate.pois.map((poi) => (
                      <td key={poi.poiId}>
                        <strong>{poi.name}</strong>
                        <small>
                          {poi.poiId} · {poi.sourceKind === 'seed' ? '种子' : poi.reviewStatus || '未审核'} · {poi.factCount} 条事实
                        </small>
                      </td>
                    ))}
                    <td>
                      {[MATCH_LABELS[candidate.nameMatch], candidate.similarity ? `相似度 ${candidate.similarity}` : ''].filter(Boolean).join(' · ') ||
                        '坐标重合'}
                    </td>
                    <td>{candidate.distanceMeters == null ? '缺坐标' : `${candidate.distanceMeters} m`}</td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ mode: 'decide', candidate })}>
                        复核
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : listReady ? (
          <EmptyState>当前没有待复核的疑似重复 POI。</EmptyState>
        ) : null}
      </section>
      <section className="ops-panel" aria-labelledby="poi-merges-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="poi-merges-title">已生效的合并</h2>
            <p className="text-caption">被合并 POI 的名称和别名会指向规范 POI；撤销后立即恢复独立查找</p>
          </div>
        </div>
        {merges.length ? (
          <ul className="space-y-2 text-sm">
            {merges.map((merge) => (
              <li key={merge.duplicatePoiId} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {merge.duplicatePoiId} → <strong>{merge.canonicalPoiId}</strong>
                  <small className="block text-muted">
                    {merge.reason} · {merge.actor} · {formatOpsDate(merge.createdAt)}
                  </small>
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ mode: 'unmerge', merge })}>
                  撤销合并
                </button>
              </li>
            ))}
          </ul>
        ) : listReady ? (
          <EmptyState>还没有合并记录。</EmptyState>
        ) : null}
      </section>
      {dialog && <MergeDecisionDialog dialog={dialog} poiLabel={poiLabel} onClose={() => setDialog(null)} onSaved={resource.retry} />}
    </div>
  );
}

function MergeDecisionDialog({ dialog, poiLabel, onClose, onSaved }) {
  const unmerge = dialog.mode === 'unmerge';
  const pois = dialog.candidate?.pois ?? [];
  const defaultCanonical = pois.find((poi) => poi.sourceKind === 'seed' || poi.reviewStatus === 'approved')?.poiId ?? pois[0]?.poiId ?? '';
  const [decision, setDecision] = useState(unmerge ? 'unmerge' : 'merge');
  const [canonicalPoiId, setCanonicalPoiId] = useState(unmerge ? dialog.merge.canonicalPoiId : defaultCanonical);
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ saving: false, error: null });
  const duplicatePoiId = unmerge ? dialog.merge.duplicatePoiId : pois.find((poi) => poi.poiId !== canonicalPoiId)?.poiId;

  async function save(event) {
    event.preventDefault();
    setState({ saving: true, error: null });
    try {
      await saveOpsPoiMergeDecision({ decision, canonicalPoiId, duplicatePoiId, reason: reason.trim() });
      onSaved();
      onClose();
    } catch (error) {
      setState({ saving: false, error });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.saving) onClose();
      }}
    >
      <DialogContent
        title={unmerge ? '撤销 POI 合并' : '复核疑似重复 POI'}
        description={unmerge ? `${duplicatePoiId} → ${canonicalPoiId}` : dialog.candidate.pairKey}
        hideClose={state.saving}
      >
        <form className="space-y-4" onSubmit={save}>
          {!unmerge && (
            <>
              <fieldset className="space-y-2">
                <legend className="input-label">结论</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="poi-decision"
                    value="merge"
                    checked={decision === 'merge'}
                    onChange={() => setDecision('merge')}
                    disabled={state.saving}
                  />
                  是同一地点，合并
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="poi-decision"
                    value="reject"
                    checked={decision === 'reject'}
                    onChange={() => setDecision('reject')}
                    disabled={state.saving}
                  />
                  不是同一地点，移出队列
                </label>
              </fieldset>
              {decision === 'merge' && (
                <fieldset className="space-y-2">
                  <legend className="input-label">保留哪个作为规范 POI（须为种子或已审核）</legend>
                  {pois.map((poi) => (
                    <label key={poi.poiId} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="poi-canonical"
                        value={poi.poiId}
                        checked={canonicalPoiId === poi.poiId}
                        onChange={() => setCanonicalPoiId(poi.poiId)}
                        disabled={state.saving}
                      />
                      {poiLabel(poi)}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          <label className="block">
            <span className="input-label">原因（至少 8 个字符）</span>
            <textarea
              className="input-field"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={8}
              maxLength={500}
              disabled={state.saving}
              placeholder="写明核对依据，例如现场照片、官方地址或地图比对"
            />
          </label>
          {state.error && (
            <p role="alert" className="ops-error-text">
              {formatApiError(state.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={state.saving}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={state.saving || reason.trim().length < 8}>
              {state.saving ? '提交中…' : '记录决定'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

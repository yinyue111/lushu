import React, { useState } from 'react';
import { CheckCircle2, FileCheck2, X } from 'lucide-react';
import { upsertPois, validatePois } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { formatApiError, formatOpsDate, hasValue, textValue } from './OpsShared';

const EDITOR_CITIES = ['杭州', '上海', '苏州'];
const REVIEW_STATUS_OPTIONS = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' }
];
// 与 server.mjs POI_SOURCE_TYPES 保持一致。
const SOURCE_TYPE_OPTIONS = [
  { value: 'official', label: '官方来源' },
  { value: 'first-party', label: '一方实拍' },
  { value: 'editorial', label: '编辑维护' },
  { value: 'field-check', label: '实地核验' },
  { value: 'user-report', label: '用户上报' },
  { value: 'derived', label: '推导数据' },
  { value: 'ai', label: 'AI 生成' },
  { value: 'fallback', label: '种子兜底' }
];
// openHours/stay/audience 不是运营 POI 的顶层字段（见 server.mjs normalizeOperationalPoiRow），
// 在结构化内容库中作为「事实」(field/value) 存储，这里提供快捷编辑入口。
const QUICK_FACT_FIELDS = [
  { field: 'openHours', label: '开放时间' },
  { field: 'stay', label: '建议停留' },
  { field: 'audience', label: '适合人群' }
];

// POI 单条查看/编辑抽屉：保存流程与批量导入一致——先 dry-run 校验拿 batchId/commitToken，
// 确认后用同一份 content 幂等提交（见 server.mjs validatePoiBatch/commitPoiBatch）。
export default function PoiEditorDrawer({ poi, onClose, onSaved }) {
  const dialogRef = useDialogFocus(Boolean(poi), onClose);
  const [form, setForm] = useState(() => buildInitialForm(poi));
  const [validation, setValidation] = useState({ status: 'idle', data: null, content: '', error: null });
  const [commit, setCommit] = useState({ status: 'idle', data: null, error: null });
  const canCommit = validation.status === 'ready' && validation.data?.canCommit === true &&
    Boolean(validation.data?.batchId) && Boolean(validation.data?.commitToken);
  const validationRow = Array.isArray(validation.data?.rows) ? validation.data.rows[0] : null;
  const rowErrors = collectIssues(validationRow?.errors);
  const rowWarnings = collectIssues(validationRow?.warnings);

  function updateForm(patch) {
    setForm((previous) => ({ ...previous, ...patch }));
    setValidation({ status: 'idle', data: null, content: '', error: null });
    setCommit({ status: 'idle', data: null, error: null });
  }

  function updateQuickFact(field, value) {
    setForm((previous) => ({ ...previous, quickFacts: { ...previous.quickFacts, [field]: value } }));
    setValidation({ status: 'idle', data: null, content: '', error: null });
    setCommit({ status: 'idle', data: null, error: null });
  }

  async function handleValidate() {
    const content = JSON.stringify(buildRowPayload(poi, form));
    setValidation({ status: 'loading', data: null, content: '', error: null });
    setCommit({ status: 'idle', data: null, error: null });
    try {
      const data = await validatePois(content);
      setValidation({ status: 'ready', data, content, error: null });
    } catch (error) {
      setValidation({ status: 'error', data: null, content: '', error });
    }
  }

  async function handleCommit() {
    if (!canCommit) return;
    setCommit({ status: 'loading', data: null, error: null });
    try {
      const data = await upsertPois({
        content: validation.content,
        batchId: validation.data.batchId,
        commitToken: validation.data.commitToken
      });
      setCommit({ status: 'ready', data, error: null });
      onSaved?.();
    } catch (error) {
      setCommit({ status: 'error', data: null, error });
    }
  }

  if (!poi) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content stop-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="poi-editor-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ padding: 20 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div>
            <h2 id="poi-editor-title" className="text-subtitle">POI 查看 / 编辑</h2>
            <p className="text-caption">
              {textValue(poi.poiId)}
              {poi.sourceKind === 'seed' ? ' · 种子数据（保存后转为运营快照）' : ''}
            </p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} aria-label="关闭编辑器">
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label>
            <span className="input-label">名称</span>
            <input className="input-field" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} />
          </label>
          <label>
            <span className="input-label">城市</span>
            <select className="input-field" value={form.city} onChange={(event) => updateForm({ city: event.target.value })}>
              {EDITOR_CITIES.map((city) => <option key={city} value={city}>{city}</option>)}
              {form.city && !EDITOR_CITIES.includes(form.city) && <option value={form.city}>{form.city}</option>}
            </select>
          </label>
          <label>
            <span className="input-label">纬度 lat</span>
            <input className="input-field" inputMode="decimal" value={form.lat} onChange={(event) => updateForm({ lat: event.target.value })} />
          </label>
          <label>
            <span className="input-label">经度 lng</span>
            <input className="input-field" inputMode="decimal" value={form.lng} onChange={(event) => updateForm({ lng: event.target.value })} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="input-label">地址</span>
            <input className="input-field" value={form.address} onChange={(event) => updateForm({ address: event.target.value })} />
          </label>
          <label>
            <span className="input-label">分类</span>
            <input className="input-field" value={form.category} onChange={(event) => updateForm({ category: event.target.value })} placeholder="如 寺庙 / 街区 / 美术馆" />
          </label>
          <label>
            <span className="input-label">别名（顿号分隔）</span>
            <input className="input-field" value={form.aliases} onChange={(event) => updateForm({ aliases: event.target.value })} />
          </label>
          <label>
            <span className="input-label">审核状态</span>
            <select className="input-field" value={form.reviewStatus} onChange={(event) => updateForm({ reviewStatus: event.target.value })}>
              {REVIEW_STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span className="input-label">来源类型</span>
            <select className="input-field" value={form.sourceType} onChange={(event) => updateForm({ sourceType: event.target.value })}>
              {SOURCE_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          {QUICK_FACT_FIELDS.map((item) => (
            <label key={item.field} style={{ gridColumn: '1 / -1' }}>
              <span className="input-label">{item.label}（存储为事实 {item.field}）</span>
              <input
                className="input-field"
                value={form.quickFacts[item.field] ?? ''}
                onChange={(event) => updateQuickFact(item.field, event.target.value)}
                placeholder="留空表示不改动"
              />
            </label>
          ))}
        </div>

        <p className="text-caption" style={{ marginTop: 12 }}>
          现有事实 {Array.isArray(poi.facts) ? poi.facts.length : 0} 条 · 证据 {Array.isArray(poi.evidence) ? poi.evidence.length : 0} 条 · 更新于 {formatOpsDate(poi.updatedAt)}。
          证据与完整事实（含有效期、证据关联）请继续用批量导入维护；快捷字段置空不会删除既有事实。
        </p>

        <div className="ops-inline-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-secondary btn-sm" type="button" onClick={handleValidate} disabled={validation.status === 'loading'}>
            <FileCheck2 size={14} /> {validation.status === 'loading' ? '校验中...' : '校验（dry-run）'}
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={handleCommit} disabled={!canCommit || commit.status === 'loading' || commit.status === 'ready'}>
            <CheckCircle2 size={14} /> {commit.status === 'loading' ? '保存中...' : commit.status === 'ready' ? '已保存' : '确认保存'}
          </button>
        </div>

        <div className="ops-live-message" role="status" aria-live="polite" aria-atomic="true">
          {validation.status === 'error' && <span className="ops-error-text">校验失败：{formatApiError(validation.error)}</span>}
          {validation.status === 'ready' && !canCommit && (
            <span className="ops-error-text">
              校验未通过{rowErrors.length ? `：${rowErrors.join('；')}` : '，请检查填写内容。'}
            </span>
          )}
          {validation.status === 'ready' && canCommit && (
            <span>
              校验通过（{actionLabel(validationRow?.status)}）{rowWarnings.length ? ` · 提示：${rowWarnings.join('；')}` : ''}，确认后写入。
            </span>
          )}
          {commit.status === 'error' && <span className="ops-error-text">保存失败：{formatApiError(commit.error)}</span>}
          {commit.status === 'ready' && (
            <span>{commit.data?.replayed ? '该批次已写入过，本次返回幂等结果。' : '保存成功，列表已刷新。'}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function buildInitialForm(poi) {
  const quickFacts = {};
  for (const { field } of QUICK_FACT_FIELDS) {
    quickFacts[field] = String(findQuickFact(poi, field)?.value ?? '');
  }
  return {
    name: String(poi?.name ?? ''),
    city: String(poi?.city ?? EDITOR_CITIES[0]),
    lat: hasValue(poi?.location?.lat) ? String(poi.location.lat) : '',
    lng: hasValue(poi?.location?.lng) ? String(poi.location.lng) : '',
    address: String(poi?.location?.address ?? ''),
    category: String(poi?.category ?? ''),
    aliases: (Array.isArray(poi?.aliases) ? poi.aliases : []).join('、'),
    reviewStatus: ['pending', 'approved', 'rejected'].includes(poi?.reviewStatus) ? poi.reviewStatus : 'pending',
    sourceType: SOURCE_TYPE_OPTIONS.some((item) => item.value === poi?.sourceType) ? poi.sourceType : 'editorial',
    quickFacts
  };
}

function findQuickFact(poi, field) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  return facts.find((fact) => fact?.field === field) ?? null;
}

// 组装单条 upsert 的最小合法 payload：poiId/city/name/location 为必填，
// facts/evidence/audits 原样回传（服务端按 id 合并，不会丢历史）。
function buildRowPayload(poi, form) {
  const facts = (Array.isArray(poi?.facts) ? poi.facts : []).map((fact) => ({ ...fact }));
  for (const { field } of QUICK_FACT_FIELDS) {
    const value = String(form.quickFacts[field] ?? '').trim();
    if (!value) continue; // 置空不删除：批量 upsert 按 id 合并，无法通过缺省删除既有事实
    const index = facts.findIndex((fact) => fact?.field === field);
    if (index >= 0) {
      if (value !== String(facts[index].value ?? '')) facts[index] = { ...facts[index], value };
    } else {
      facts.push({ field, value, sourceType: 'editorial', reviewStatus: 'pending' });
    }
  }
  return {
    poiId: String(poi?.poiId || poi?.id || ''),
    city: form.city.trim(),
    name: form.name.trim(),
    aliases: form.aliases.split(/[、,，;；\n]/).map((alias) => alias.trim()).filter(Boolean),
    category: form.category.trim(),
    location: {
      lat: Number(form.lat),
      lng: Number(form.lng),
      address: form.address.trim()
    },
    sourceType: form.sourceType,
    reviewStatus: form.reviewStatus,
    facts,
    evidence: Array.isArray(poi?.evidence) ? poi.evidence : [],
    audits: Array.isArray(poi?.audits) ? poi.audits : [],
    createdAt: poi?.createdAt || ''
  };
}

function collectIssues(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => typeof item === 'string' ? item : [item?.path || item?.field, item?.message || item?.code].filter(Boolean).join('：'))
    .filter(Boolean);
}

function actionLabel(value) {
  return ({ new: '新增', update: '更新', unchanged: '无变化' })[String(value ?? '')] || '待写入';
}

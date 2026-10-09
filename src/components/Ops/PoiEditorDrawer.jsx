import { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileCheck2, History } from 'lucide-react';
import { upsertPois, validatePois } from '../../lib/api';
import { Dialog, DialogContent } from '../ui/dialog';
import { formatApiError, formatOpsDate, textValue } from './OpsShared';
import PoiEvidenceFields from './PoiEvidenceFields';
import PoiFactFields from './PoiFactFields';
import {
  REVIEW_STATUS_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  buildInitialPoiEditorForm,
  buildPoiEditorPayload,
  collectPoiReviewChanges,
  createEmptyEvidence,
  createEmptyFact,
  validatePoiEditorForm
} from './poiEditorModel';

const trustedCities = ['杭州', '上海', '苏州'];

// 单条维护与批量导入共用 validate -> commitToken -> upsert 两阶段写入，
// 证据、事实与审核记录不会走旁路 API。
export default function PoiEditorDrawer({ poi, onClose, onSaved }) {
  const [form, setForm] = useState(() => buildInitialPoiEditorForm(poi));
  const [validation, setValidation] = useState({ status: 'idle', data: null, content: '', error: null, clientErrors: [], clientWarnings: [] });
  const [commit, setCommit] = useState({ status: 'idle', data: null, error: null });
  const canCommit =
    validation.status === 'ready' && validation.data?.canCommit === true && Boolean(validation.data?.batchId) && Boolean(validation.data?.commitToken);
  const validationRow = Array.isArray(validation.data?.rows) ? validation.data.rows[0] : null;
  const rowErrors = collectIssues(validationRow?.errors);
  const rowWarnings = [...validation.clientWarnings, ...collectIssues(validationRow?.warnings)];
  const reviewChanges = collectPoiReviewChanges(poi, form);

  function updateForm(patchOrUpdater) {
    setForm((previous) => (typeof patchOrUpdater === 'function' ? patchOrUpdater(previous) : { ...previous, ...patchOrUpdater }));
    setValidation({ status: 'idle', data: null, content: '', error: null, clientErrors: [], clientWarnings: [] });
    setCommit({ status: 'idle', data: null, error: null });
  }

  function updateCollection(collection, index, patch) {
    updateForm((previous) => ({
      ...previous,
      [collection]: previous[collection].map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    }));
  }

  function removeNewRow(collection, index) {
    updateForm((previous) => ({
      ...previous,
      [collection]: previous[collection].filter((item, itemIndex) => itemIndex !== index || item.existing)
    }));
  }

  async function handleValidate() {
    const clientCheck = validatePoiEditorForm(poi, form);
    if (clientCheck.errors.length) {
      setValidation({ status: 'client-error', data: null, content: '', error: null, clientErrors: clientCheck.errors, clientWarnings: clientCheck.warnings });
      setCommit({ status: 'idle', data: null, error: null });
      return;
    }
    const content = JSON.stringify(buildPoiEditorPayload(poi, form));
    setValidation({ status: 'loading', data: null, content: '', error: null, clientErrors: [], clientWarnings: clientCheck.warnings });
    setCommit({ status: 'idle', data: null, error: null });
    try {
      const data = await validatePois(content);
      setValidation({ status: 'ready', data, content, error: null, clientErrors: [], clientWarnings: clientCheck.warnings });
    } catch (error) {
      setValidation({ status: 'error', data: null, content: '', error, clientErrors: [], clientWarnings: clientCheck.warnings });
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
  const poiId = String(poi.poiId || poi.id || '');

  return (
    <Dialog
      open={Boolean(poi)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[min(960px,calc(100vw-24px))]" title={textValue(poi.name)} description={`${textValue(poiId)} · 内容核验工作台`}>
        <div className="space-y-4">
          <section className="space-y-4 rounded-panel border border-line p-4" aria-labelledby="poi-basic-title">
            <div className="flex flex-wrap items-start justify-between gap-3 [&_h3]:font-bold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted">
              <div>
                <h3 id="poi-basic-title">基础信息</h3>
                <p>名称、城市和坐标仍会经过服务端城市范围校验。</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <EditorField id="poi-editor-name" label="名称">
                <input id="poi-editor-name" className="input-field" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} />
              </EditorField>
              <EditorField id="poi-editor-city" label="城市">
                <select id="poi-editor-city" className="input-field" value={form.city} onChange={(event) => updateForm({ city: event.target.value })}>
                  {trustedCities.map((city) => (
                    <option key={city} value={city}>
                      {city}
                    </option>
                  ))}
                  {form.city && !trustedCities.includes(form.city) && <option value={form.city}>{form.city}</option>}
                </select>
              </EditorField>
              <EditorField id="poi-editor-lat" label="纬度 lat">
                <input
                  id="poi-editor-lat"
                  className="input-field"
                  inputMode="decimal"
                  value={form.lat}
                  onChange={(event) => updateForm({ lat: event.target.value })}
                />
              </EditorField>
              <EditorField id="poi-editor-lng" label="经度 lng">
                <input
                  id="poi-editor-lng"
                  className="input-field"
                  inputMode="decimal"
                  value={form.lng}
                  onChange={(event) => updateForm({ lng: event.target.value })}
                />
              </EditorField>
              <EditorField className="sm:col-span-2" id="poi-editor-address" label="地址">
                <input id="poi-editor-address" className="input-field" value={form.address} onChange={(event) => updateForm({ address: event.target.value })} />
              </EditorField>
              <EditorField id="poi-editor-category" label="分类">
                <input
                  id="poi-editor-category"
                  className="input-field"
                  value={form.category}
                  onChange={(event) => updateForm({ category: event.target.value })}
                  placeholder="如：寺庙 / 街区 / 美术馆"
                />
              </EditorField>
              <EditorField id="poi-editor-aliases" label="别名（顿号分隔）">
                <input id="poi-editor-aliases" className="input-field" value={form.aliases} onChange={(event) => updateForm({ aliases: event.target.value })} />
              </EditorField>
              <EditorField id="poi-editor-source-type" label="POI 来源类型">
                <select
                  id="poi-editor-source-type"
                  className="input-field"
                  value={form.sourceType}
                  onChange={(event) => updateForm({ sourceType: event.target.value })}
                >
                  {SOURCE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </EditorField>
              <EditorField id="poi-editor-status" label="POI 审核状态">
                <select
                  id="poi-editor-status"
                  className="input-field"
                  value={form.reviewStatus}
                  onChange={(event) => updateForm({ reviewStatus: event.target.value })}
                >
                  {REVIEW_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </EditorField>
            </div>
          </section>

          <PoiEvidenceFields
            items={form.evidence}
            onAdd={() => updateForm((previous) => ({ ...previous, evidence: [...previous.evidence, createEmptyEvidence(poiId)] }))}
            onChange={(index, patch) => updateCollection('evidence', index, patch)}
            onRemove={(index) => removeNewRow('evidence', index)}
          />
          <PoiFactFields
            items={form.facts}
            evidence={form.evidence}
            onAdd={() => updateForm((previous) => ({ ...previous, facts: [...previous.facts, createEmptyFact(poiId)] }))}
            onChange={(index, patch) => updateCollection('facts', index, patch)}
            onRemove={(index) => removeNewRow('facts', index)}
          />

          <section className="space-y-4 rounded-panel border border-line p-4" aria-labelledby="poi-review-title">
            <div className="flex flex-wrap items-start justify-between gap-3 [&_h3]:font-bold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted">
              <div>
                <h3 id="poi-review-title">审核说明</h3>
                <p>任何 POI、证据或事实状态变化都必须记录原因，保存后会写入审计历史。</p>
              </div>
            </div>
            {reviewChanges.length > 0 && (
              <div className="space-y-2 rounded-card bg-canvas p-3 text-sm [&_ul]:list-inside [&_ul]:list-disc" role="status">
                <strong>本次状态变化</strong>
                <ul>
                  {reviewChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </div>
            )}
            <EditorField id="poi-editor-review-note" label={reviewChanges.length ? '审核备注（必填）' : '维护备注（可选）'}>
              <textarea
                id="poi-editor-review-note"
                className="input-field"
                value={form.reviewNote}
                maxLength={400}
                onChange={(event) => updateForm({ reviewNote: event.target.value })}
                placeholder="写明核验依据、状态变化原因或本次维护范围"
                required={reviewChanges.length > 0}
              />
            </EditorField>
            <AuditHistory audits={poi.audits} />
          </section>
        </div>

        <footer className="sticky bottom-0 mt-4 space-y-3 border-t border-line bg-white pt-4">
          <div className="text-sm" aria-live="polite" aria-atomic="true">
            {validation.status === 'client-error' && <IssueList items={validation.clientErrors} tone="error" />}
            {validation.status === 'error' && <span className="ops-error-text">校验失败：{formatApiError(validation.error)}</span>}
            {validation.status === 'ready' && !canCommit && <IssueList items={rowErrors.length ? rowErrors : ['校验未通过，请检查填写内容。']} tone="error" />}
            {validation.status === 'ready' && canCommit && (
              <span>
                校验通过（{actionLabel(validationRow?.status)}）{rowWarnings.length ? ` · ${rowWarnings.join('；')}` : ''}
              </span>
            )}
            {commit.status === 'error' && <span className="ops-error-text">保存失败：{formatApiError(commit.error)}</span>}
            {commit.status === 'ready' && <span>{commit.data?.replayed ? '该批次已写入，本次返回幂等结果。' : '保存成功，库存与覆盖率已刷新。'}</span>}
          </div>
          <div className="ops-inline-actions">
            <button className="btn btn-secondary btn-sm" type="button" onClick={handleValidate} disabled={validation.status === 'loading'}>
              <FileCheck2 size={14} /> {validation.status === 'loading' ? '校验中…' : '校验（dry-run）'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={handleCommit}
              disabled={!canCommit || commit.status === 'loading' || commit.status === 'ready'}
            >
              <CheckCircle2 size={14} /> {commit.status === 'loading' ? '保存中…' : commit.status === 'ready' ? '已保存' : '确认保存'}
            </button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function EditorField({ id, label, className = '', children }) {
  return (
    <label className={className} htmlFor={id}>
      <span className="input-label">{label}</span>
      {children}
    </label>
  );
}

function AuditHistory({ audits }) {
  const rows = (Array.isArray(audits) ? audits : []).slice(-4).reverse();
  return (
    <div className="space-y-2 text-sm [&_h4]:flex [&_h4]:items-center [&_h4]:gap-1 [&_h4]:font-semibold [&_div]:grid [&_div]:gap-1 [&_div]:border-t [&_div]:border-line [&_div]:pt-2 [&_time]:text-muted">
      <h4>
        <History size={14} /> 最近审计
      </h4>
      {rows.length ? (
        rows.map((audit, index) => (
          <div key={audit.id || `${audit.createdAt}-${index}`}>
            <strong>{audit.action || 'review'}</strong>
            <span>{audit.note || '系统批次记录'}</span>
            <time dateTime={audit.createdAt}>{formatOpsDate(audit.createdAt)}</time>
          </div>
        ))
      ) : (
        <p>暂无人工审核记录。</p>
      )}
    </div>
  );
}

function IssueList({ items, tone }) {
  return (
    <div className={tone === 'error' ? 'poi-editor-issues is-error' : 'poi-editor-issues'} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertTriangle size={14} />
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function collectIssues(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => (typeof item === 'string' ? item : [item?.path || item?.field, item?.message || item?.code].filter(Boolean).join('：')))
    .filter(Boolean);
}

function actionLabel(value) {
  return { new: '新增', update: '更新', unchanged: '无变化' }[String(value ?? '')] || '待写入';
}

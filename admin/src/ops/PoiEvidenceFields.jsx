import { FilePlus2, Link2, Trash2 } from 'lucide-react';
import { EVIDENCE_TYPE_OPTIONS, REVIEW_STATUS_OPTIONS, SOURCE_TYPE_OPTIONS, evidenceDisplayName } from './poiEditorModel';

export default function PoiEvidenceFields({ items, onAdd, onChange, onRemove }) {
  return (
    <section className="space-y-4 rounded-panel border border-line p-4" aria-labelledby="poi-evidence-title">
      <div className="flex flex-wrap items-start justify-between gap-3 [&_h3]:font-bold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted">
        <div>
          <h3 id="poi-evidence-title">核验凭据</h3>
          <p>审核通过的证据必须有 URL 或受控文档 ID，并记录采集日期。</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onAdd}>
          <FilePlus2 size={14} /> 新增证据
        </button>
      </div>

      {items.length ? (
        <div className="space-y-4">
          {items.map((item, index) => {
            const prefix = `poi-evidence-${index}`;
            return (
              <fieldset className="rounded-card border border-line p-4 [&_legend]:px-2 [&_legend]:font-semibold" key={item.id}>
                <legend>
                  <span>
                    <Link2 size={14} /> {evidenceDisplayName(item, index)}
                  </span>
                  <small>{item.existing ? '已入库' : '本次新增'}</small>
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <EditorField id={`${prefix}-title`} label="证据标题">
                    <input
                      id={`${prefix}-title`}
                      className="input-field"
                      value={item.title}
                      maxLength={160}
                      onChange={(event) => onChange(index, { title: event.target.value })}
                      placeholder="如：景区官网开放信息"
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-publisher`} label="发布方">
                    <input
                      id={`${prefix}-publisher`}
                      className="input-field"
                      value={item.publisher}
                      maxLength={100}
                      onChange={(event) => onChange(index, { publisher: event.target.value })}
                      placeholder="机构或资料发布方"
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-type`} label="证据类型">
                    <select id={`${prefix}-type`} className="input-field" value={item.type} onChange={(event) => onChange(index, { type: event.target.value })}>
                      {EVIDENCE_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </EditorField>
                  <EditorField id={`${prefix}-source-type`} label="来源类型">
                    <select
                      id={`${prefix}-source-type`}
                      className="input-field"
                      value={item.sourceType}
                      onChange={(event) => onChange(index, { sourceType: event.target.value })}
                    >
                      {SOURCE_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </EditorField>
                  <EditorField className="sm:col-span-2" id={`${prefix}-url`} label="来源 URL">
                    <input
                      id={`${prefix}-url`}
                      className="input-field"
                      type="url"
                      value={item.url}
                      maxLength={500}
                      onChange={(event) => onChange(index, { url: event.target.value })}
                      placeholder="https://..."
                    />
                  </EditorField>
                  <EditorField className="sm:col-span-2" id={`${prefix}-document`} label="受控文档 ID">
                    <input
                      id={`${prefix}-document`}
                      className="input-field"
                      value={item.documentId}
                      maxLength={160}
                      onChange={(event) => onChange(index, { documentId: event.target.value })}
                      placeholder="没有公开 URL 时填写内部可追溯文档编号"
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-captured`} label="采集日期">
                    <input
                      id={`${prefix}-captured`}
                      className="input-field"
                      type="date"
                      value={item.capturedAt}
                      onChange={(event) => onChange(index, { capturedAt: event.target.value })}
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-published`} label="发布日期（可选）">
                    <input
                      id={`${prefix}-published`}
                      className="input-field"
                      type="date"
                      value={item.publishedAt}
                      onChange={(event) => onChange(index, { publishedAt: event.target.value })}
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-status`} label="证据审核">
                    <select
                      id={`${prefix}-status`}
                      className="input-field"
                      value={item.reviewStatus}
                      onChange={(event) => onChange(index, { reviewStatus: event.target.value })}
                    >
                      {REVIEW_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </EditorField>
                  <EditorField className="sm:col-span-2" id={`${prefix}-note`} label="证据备注">
                    <textarea
                      id={`${prefix}-note`}
                      className="input-field"
                      value={item.note}
                      maxLength={500}
                      onChange={(event) => onChange(index, { note: event.target.value })}
                      placeholder="记录核验范围、页码或需要后续关注的限制"
                    />
                  </EditorField>
                </div>
                {!item.existing && (
                  <button className="btn btn-secondary btn-sm mt-3" type="button" onClick={() => onRemove(index)}>
                    <Trash2 size={13} /> 移除未保存证据
                  </button>
                )}
              </fieldset>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">还没有核验凭据。新增后可与事实绑定。</p>
      )}
    </section>
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

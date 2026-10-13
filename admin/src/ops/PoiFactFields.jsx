import { Braces, Plus, Trash2 } from 'lucide-react';
import { REVIEW_STATUS_OPTIONS, SOURCE_TYPE_OPTIONS, evidenceDisplayName } from './poiEditorModel';

export default function PoiFactFields({ items, evidence, onAdd, onChange, onRemove }) {
  return (
    <section className="space-y-4 rounded-panel border border-line p-4" aria-labelledby="poi-facts-title">
      <div className="flex flex-wrap items-start justify-between gap-3 [&_h3]:font-bold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted">
        <div>
          <h3 id="poi-facts-title">结构化事实</h3>
          <p>事实通过审核后仍需绑定已通过证据并填写有效期，才能进入“新鲜/已核验”。</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onAdd}>
          <Plus size={14} /> 新增事实
        </button>
      </div>

      {items.length ? (
        <div className="space-y-4">
          {items.map((item, index) => {
            const prefix = `poi-fact-${index}`;
            return (
              <fieldset className="rounded-card border border-line p-4 [&_legend]:px-2 [&_legend]:font-semibold" key={item.id}>
                <legend>
                  <span>
                    <Braces size={14} /> {item.field.trim() || `事实 ${index + 1}`}
                  </span>
                  <small>{item.existing ? '已入库' : '本次新增'}</small>
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <EditorField id={`${prefix}-field`} label="事实字段">
                    <input
                      id={`${prefix}-field`}
                      className="input-field"
                      value={item.field}
                      maxLength={80}
                      onChange={(event) => onChange(index, { field: event.target.value })}
                      placeholder="如：官方坐标 / 开放时间 / 预约要求"
                    />
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
                  <EditorField className="sm:col-span-2" id={`${prefix}-value`} label="事实值">
                    <textarea
                      id={`${prefix}-value`}
                      className="input-field"
                      value={item.value}
                      maxLength={1000}
                      onChange={(event) => onChange(index, { value: event.target.value })}
                      placeholder="填写经过来源核验的完整事实"
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-valid-from`} label="生效日期（可选）">
                    <input
                      id={`${prefix}-valid-from`}
                      className="input-field"
                      type="date"
                      value={item.validFrom}
                      onChange={(event) => onChange(index, { validFrom: event.target.value })}
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-valid-until`} label="有效期至">
                    <input
                      id={`${prefix}-valid-until`}
                      className="input-field"
                      type="date"
                      value={item.validUntil}
                      onChange={(event) => onChange(index, { validUntil: event.target.value })}
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-verified`} label="核验日期（可选）">
                    <input
                      id={`${prefix}-verified`}
                      className="input-field"
                      type="date"
                      value={item.verifiedAt}
                      onChange={(event) => onChange(index, { verifiedAt: event.target.value })}
                    />
                  </EditorField>
                  <EditorField id={`${prefix}-status`} label="事实审核">
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
                  <fieldset className="space-y-2 sm:col-span-2 [&_label]:flex [&_label]:items-center [&_label]:gap-2">
                    <legend>关联证据</legend>
                    {evidence.length ? (
                      evidence.map((evidenceItem, evidenceIndex) => (
                        <label key={evidenceItem.id}>
                          <input
                            type="checkbox"
                            checked={item.evidenceIds.includes(evidenceItem.id)}
                            onChange={(event) =>
                              onChange(index, {
                                evidenceIds: event.target.checked
                                  ? [...new Set([...item.evidenceIds, evidenceItem.id])]
                                  : item.evidenceIds.filter((id) => id !== evidenceItem.id)
                              })
                            }
                          />
                          <span>{evidenceDisplayName(evidenceItem, evidenceIndex)}</span>
                          <small>{evidenceItem.reviewStatus === 'approved' ? '已通过' : evidenceItem.reviewStatus === 'rejected' ? '已驳回' : '待审核'}</small>
                        </label>
                      ))
                    ) : (
                      <p>请先新增核验凭据。</p>
                    )}
                  </fieldset>
                  <EditorField className="sm:col-span-2" id={`${prefix}-note`} label="事实备注">
                    <textarea
                      id={`${prefix}-note`}
                      className="input-field"
                      value={item.note}
                      maxLength={500}
                      onChange={(event) => onChange(index, { note: event.target.value })}
                      placeholder="说明适用条件或需要复核的边界"
                    />
                  </EditorField>
                </div>
                {!item.existing && (
                  <button className="btn btn-secondary btn-sm mt-3" type="button" onClick={() => onRemove(index)}>
                    <Trash2 size={13} /> 移除未保存事实
                  </button>
                )}
              </fieldset>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">还没有结构化事实。建议先录入“官方坐标”和“开放时间”。</p>
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

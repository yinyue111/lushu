import { useState } from 'react';
import { Dialog, DialogContent } from '../ui/dialog';
import { saveOpsDisposition } from '../../lib/opsApi';
import { formatApiError, formatOpsDate } from './OpsShared';

const CHECKIN_ACTIONS = [
  ['exclude', '排除可信样本'],
  ['restore', '恢复可信样本'],
  ['mark-commercial-incentive', '标记商业激励'],
  ['clear-commercial-incentive', '清除商业激励标记']
];
const SOURCE_ACTIONS = [
  ['update-authorization', '维护授权'],
  ['revoke-authorization', '撤销授权'],
  ['feature', '设为精选来源'],
  ['unfeature', '取消精选']
];
const AUTHORIZATIONS = [
  ['personal-use-only', '仅个人使用', 'private-routebook-generation'],
  ['authorization-pending', '授权待核验', 'private-routebook-generation'],
  ['authorized-public', '已获公开引用授权', 'public-routebook-citation'],
  ['not-applicable', '无需引用授权', 'none']
];

export default function OpsAuditDialog({ entity, onClose, onSaved }) {
  const source = entity.type === 'import-source';
  const [action, setAction] = useState(source ? 'update-authorization' : entity.disposition?.excluded ? 'restore' : 'exclude');
  const [authorization, setAuthorization] = useState(
    entity.disposition?.authorizationStatus === 'revoked' ? 'authorization-pending' : entity.disposition?.authorizationStatus || 'personal-use-only'
  );
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ saving: false, error: null });
  const actions = source ? SOURCE_ACTIONS : CHECKIN_ACTIONS;
  async function save(event) {
    event.preventDefault();
    setState({ saving: true, error: null });
    try {
      const selected = AUTHORIZATIONS.find(([status]) => status === authorization);
      await saveOpsDisposition(entity.type, entity.id, {
        action,
        reason: reason.trim(),
        ...(action === 'update-authorization' ? { authorizationStatus: selected[0], authorizationScope: selected[2] } : {})
      });
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
      <DialogContent title={source ? '来源授权与精选处置' : '打卡可信样本处置'} description={entity.title || entity.id} hideClose={state.saving}>
        <form className="space-y-4" onSubmit={save}>
          <p className="text-sm text-muted">处置后保留原始记录和完整审计。排除或商业激励样本将退出公开可信度与回顾；撤权会撤下来源引用。</p>
          <label className="block">
            <span className="input-label">处置动作</span>
            <select className="input-field" value={action} disabled={state.saving} onChange={(event) => setAction(event.target.value)}>
              {actions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {action === 'update-authorization' && (
            <label className="block">
              <span className="input-label">授权范围</span>
              <select className="input-field" value={authorization} disabled={state.saving} onChange={(event) => setAuthorization(event.target.value)}>
                {AUTHORIZATIONS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source && entity.proofReady === false && (
            <p className="rounded-card bg-canvas p-3 text-sm">历史来源未保留可校验签名。可撤权或记录待核验，公开授权和精选前需重新导入。</p>
          )}
          <label className="block">
            <span className="input-label">处置原因（至少 8 个字符）</span>
            <textarea
              className="input-field"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={8}
              maxLength={500}
              disabled={state.saving}
              placeholder="写明核验依据、授权文件编号或处置原因"
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
              {state.saving ? '提交中…' : '记录处置'}
            </button>
          </div>
        </form>
        <section className="mt-5 border-t border-line pt-4" aria-label="处置历史">
          <h3 className="font-bold">处置历史</h3>
          {entity.history?.length ? (
            <ol className="mt-2 space-y-3 text-sm">
              {entity.history.slice(0, 8).map((event) => (
                <li key={event.id}>
                  <p>
                    {[...CHECKIN_ACTIONS, ...SOURCE_ACTIONS].find(([id]) => id === event.action)?.[1] || event.action} · {formatOpsDate(event.createdAt)}
                  </p>
                  <p className="text-muted">
                    {event.reason} · {event.actor}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted">暂无处置记录。</p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

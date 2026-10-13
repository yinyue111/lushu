import { useId, useState } from 'react';
import { RefreshCw, Search, Users } from 'lucide-react';
import { Dialog, DialogContent } from '../../../src/components/ui/dialog';
import { getOpsUsers, saveOpsUserAction } from '../lib/opsApi';
import { EmptyState, ResourceNotice, formatApiError, formatOpsDate, useOpsResource } from './OpsShared';

const ACTIONS = {
  disable: { label: '停用', note: '停用后立刻退出所有设备，不能登录。' },
  enable: { label: '恢复', note: '恢复后可以重新登录。' },
  'revoke-sessions': { label: '强制退出', note: '所有设备退出登录，账号仍可用。' },
  // 补发恢复码 moved to the admin console 「用户 → 发恢复码」 (mailed to the verified email only).
  'set-quota': { label: '设生成额度', note: '每个统计窗口内可生成的次数；留空 = 用默认额度。' }
};

// 账号管理：只显示打码的邮箱和手机号；所有操作都要写原因并记入运营审计。
export default function UsersPanel() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [dialog, setDialog] = useState(null);
  const resource = useOpsResource((signal) => getOpsUsers(submitted, signal), { dependencies: [submitted], isEmpty: (data) => !data?.users?.length });
  const users = resource.data?.users ?? [];
  const searchId = useId();
  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="ops-users-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-users-title">账号</h2>
            <p className="text-caption">只显示打码的邮箱和手机号。按完整邮箱、完整手机号或手机号后 4 位搜索；所有操作都要写原因，并记入审计。</p>
          </div>
          <span className="badge badge-orange">
            <Users size={12} /> {resource.data ? `${users.length} 个` : '—'}
          </span>
        </div>
        {resource.data?.enabled === false ? (
          <EmptyState>账号功能没开启（AUTH_MODE=access-code）。</EmptyState>
        ) : (
          <>
            <form
              className="ops-filter-bar"
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(query.trim());
              }}
            >
              <label htmlFor={searchId}>
                <span>邮箱或手机号</span>
                <input
                  id={searchId}
                  className="input-field"
                  inputMode="email"
                  placeholder="完整邮箱 / 手机号后 4 位"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <button className="btn btn-secondary btn-sm" type="submit">
                <Search size={13} /> 搜索
              </button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={resource.retry} disabled={resource.status === 'loading'}>
                <RefreshCw size={13} /> 刷新
              </button>
            </form>
            <ResourceNotice resource={resource} label="账号列表" />
            {users.length ? (
              <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="账号列表，可横向滚动">
                <table className="ops-data-table">
                  <thead>
                    <tr>
                      <th>邮箱 / 手机号</th>
                      <th>状态</th>
                      <th>注册 / 最近登录</th>
                      <th>在线设备</th>
                      <th>生成（窗口内 / 额度）</th>
                      <th>恢复码</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          {user.emailMasked ? (
                            <strong className="break-all">
                              {user.emailMasked}{' '}
                              <span className={`badge ${user.emailVerified ? 'badge-green' : 'badge-orange'}`}>{user.emailVerified ? '已验证' : '未验证'}</span>
                            </strong>
                          ) : (
                            <strong>
                              <span className="badge badge-orange">没有邮箱</span>
                            </strong>
                          )}
                          {user.phoneMasked && <small className="num">{user.phoneMasked}</small>}
                          <small>{user.id}</small>
                        </td>
                        <td>
                          <span className={`badge ${user.status === 'active' ? 'badge-green' : 'badge-orange'}`}>
                            {user.status === 'active' ? '正常' : '已停用'}
                          </span>
                        </td>
                        <td>
                          {formatOpsDate(user.createdAt)}
                          <small>{formatOpsDate(user.lastLoginAt, '还没登录过')}</small>
                        </td>
                        <td>{user.activeSessions ?? 0}</td>
                        <td>
                          {user.generationsInWindow ?? 0} / {user.generationQuota ?? '默认'}
                        </td>
                        <td>{user.recoveryCodesLeft}</td>
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            {(user.status === 'active' ? ['disable', 'revoke-sessions', 'set-quota'] : ['enable']).map((action) => (
                              <button key={action} type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ user, action })}>
                                {ACTIONS[action].label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : resource.status === 'empty' ? (
              <EmptyState>{submitted ? '没有找到这个号码的账号。' : '还没有账号。'}</EmptyState>
            ) : null}
          </>
        )}
      </section>
      {dialog && <UserActionDialog {...dialog} onClose={() => setDialog(null)} onDone={resource.retry} />}
    </div>
  );
}

function UserActionDialog({ user, action, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [quota, setQuota] = useState(user.generationQuota ?? '');
  const [state, setState] = useState({ busy: false, error: '', code: '' });
  const reasonId = useId();
  const quotaId = useId();
  const submit = async (event) => {
    event.preventDefault();
    setState({ busy: true, error: '', code: '' });
    try {
      const data = await saveOpsUserAction(user.id, { action, reason, ...(action === 'set-quota' ? { quota: quota === '' ? null : Number(quota) } : {}) });
      setState({ busy: false, error: '', code: data.recoveryCode || '' });
      onDone();
      if (!data.recoveryCode) onClose();
    } catch (error) {
      setState({ busy: false, error: formatApiError(error), code: '' });
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`${ACTIONS[action].label}：${user.emailMasked || user.phoneMasked}`} description={ACTIONS[action].note}>
        {state.code ? (
          <div className="grid gap-3">
            <p className="text-sm">一次性恢复码（只显示这一次）：</p>
            <p className="rounded-tile bg-canvas p-3 text-center font-mono text-lg font-bold tracking-wider">{state.code}</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              已交给本人，关闭
            </button>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={submit}>
            {action === 'set-quota' && (
              <>
                <label htmlFor={quotaId} className="text-sm font-bold">
                  生成额度
                </label>
                <input
                  id={quotaId}
                  className="input-field"
                  inputMode="numeric"
                  value={quota}
                  onChange={(event) => setQuota(event.target.value.replace(/\D/g, ''))}
                  placeholder="留空 = 默认"
                />
              </>
            )}
            <label htmlFor={reasonId} className="text-sm font-bold">
              原因（记入审计）
            </label>
            <textarea
              id={reasonId}
              className="input-field min-h-20"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={4}
            />
            {state.error && (
              <p role="alert" className="text-sm font-semibold text-danger">
                {state.error}
              </p>
            )}
            <button type="submit" className="btn btn-primary" disabled={state.busy || reason.trim().length < 4}>
              确认{ACTIONS[action].label}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

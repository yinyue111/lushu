import { Copy, Download, KeyRound, LogOut, RotateCcw, Save, Trash2, UserRound } from 'lucide-react';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { cn } from '../ui/cn';
import { useAccount } from '../Account/AccountProvider';
import { AccountSection } from '../Account/AccountSection';

/**
 * Account + travel preference form. State and side effects live in MyPage; this
 * component only renders.
 * @param {Record<string, any>} props
 */
export function MyAccountPanel({
  profile,
  setProfile,
  syncCode,
  recoveryCode,
  setRecoveryCode,
  syncBusy,
  profileMessage,
  onSave,
  onPrepareSyncCode,
  onRecover,
  onExport,
  onLogout,
  onDelete,
  onOpenCreator
}) {
  const { enabled: accountsEnabled, required: loginRequired, account } = useAccount();
  // With accounts on, the account (not this device's token) carries sync, logout and deletion.
  const legacyDeviceAccount = !account && !loginRequired;
  const set = (key) => (event) => setProfile((prev) => ({ ...prev, [key]: event.target.value }));
  const setList = (key) => (event) => setProfile((prev) => ({ ...prev, [key]: event.target.value.split(/[、,\s]+/).filter(Boolean) }));
  return (
    // Preferences are their own form so the account forms beside them are never nested inside it.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form className="rounded-panel border border-line bg-white p-5 shadow-card" onSubmit={onSave}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">旅行偏好</h2>
            <p className="mt-0.5 text-sm text-muted">下次生成路书会默认套用。</p>
          </div>
          <span className="num max-w-[45%] truncate rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-muted" title={profile.id}>
            {profile.id}
          </span>
        </div>
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
          <Field label="常住 / 出发城市">
            <input className={inputClass} value={profile.homeCity ?? ''} onChange={set('homeCity')} />
          </Field>
          <Field label="常去城市">
            <input className={inputClass} value={(profile.preferredCities ?? []).join('、')} onChange={setList('preferredCities')} />
          </Field>
          <Field label="默认预算（每人）">
            <input className={inputClass} value={profile.budget ?? ''} onChange={set('budget')} placeholder="例如：每人全程 900 元；留空 = 不设预算" />
          </Field>
          <Field label="主题偏好">
            <input className={inputClass} value={(profile.themes ?? []).join('、')} onChange={setList('themes')} />
          </Field>
          <Field label="和谁一起">
            <input className={inputClass} value={profile.companion ?? ''} onChange={set('companion')} />
          </Field>
          <Field label="节奏">
            <input className={inputClass} value={profile.tempo ?? ''} onChange={set('tempo')} />
          </Field>
          <Field label="作者名" hint="发布路线时显示的名字">
            <input className={inputClass} value={profile.creatorName ?? ''} onChange={set('creatorName')} placeholder="比如：周末去哪儿小王" />
          </Field>
          <Field label="作者简介（选填）" className="sm:col-span-2">
            <textarea
              className={cn(inputClass, 'min-h-20')}
              value={profile.creatorBio ?? ''}
              onChange={set('creatorBio')}
              placeholder="例如：周末短途路线整理者，偏好少绕路和真实打卡反馈"
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" variant="primary">
            <Save /> 保存偏好
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenCreator?.(profile.id)}>
            <UserRound /> 看我的作者主页
          </Button>
        </div>
        {legacyDeviceAccount && (
          <label className="mt-4 flex items-start gap-2 rounded-tile bg-canvas p-3 text-sm text-ink-2">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={Boolean(profile.profileAccessToken || profile.cloudRegistrationConsentAt)}
              disabled={Boolean(profile.profileAccessToken) || syncBusy}
              onChange={(event) =>
                setProfile((previous) => ({ ...previous, cloudRegistrationConsentAt: event.target.checked ? new Date().toISOString() : '' }))
              }
            />
            <span>同意将资料和旅行记录同步到云端，用于跨设备继续行程。未开启时仅保存在本机；已开启后可在下方注销并删除。</span>
          </label>
        )}
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mt-3">
          {profileMessage}
        </p>
      </form>

      <div className="grid content-start gap-5">
        {accountsEnabled && <AccountSection />}
        {!accountsEnabled && (
          <section className="rounded-panel border border-line bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-extrabold">正式账号</h2>
                <p className="mt-1 text-sm text-muted">
                  {profile.identityBound
                    ? `当前资料保留已有身份记录：${profile.identity?.label || '已绑定身份'}；新的短信或微信绑定暂未开放。`
                    : '短信验证码和微信登录还没接入，所以现在不收集手机号或微信 OpenID。可以继续用本机资料，并用下面的恢复码换设备。'}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-sky-soft px-2.5 py-1 text-xs font-bold text-sky-ink">
                {profile.identityBound ? '已有记录' : '即将开放'}
              </span>
            </div>
          </section>
        )}
        {legacyDeviceAccount && (
          <>
            <section className="rounded-panel border border-line bg-white p-5">
              <h2 className="text-lg font-extrabold">这台设备上的资料</h2>
              <p className="mt-1 text-sm text-muted">
                你还没登录，路书只存在这台设备上。导出不含访问凭据。注销会删除当前服务中的资料、照片和本机副本；已被他人下载及运营备份中的副本不在即时删除范围。{' '}
                <a className="underline" href="/privacy">
                  查看隐私说明（草案）与定位授权
                </a>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={syncBusy} onClick={onExport}>
                  <Download /> 导出资料
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={syncBusy || (Boolean(profile.profileAccessToken) && !profile.identityBound)}
                  onClick={onLogout}
                >
                  <LogOut /> 退出本机身份
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={syncBusy} onClick={onDelete}>
                  <Trash2 /> 删除本机资料
                </Button>
              </div>
              {profile.profileAccessToken && !profile.identityBound && (
                <p className="mt-2 text-xs text-muted">当前为恢复码账号，撤销凭据后无法重新登录，因此暂不支持直接退出；可先导出，再注销。</p>
              )}
            </section>

            <section className="rounded-panel border border-line bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-1.5 text-lg font-extrabold">
                    <KeyRound className="size-[18px] text-primary-strong" aria-hidden="true" /> 换设备继续用
                  </h2>
                  <p className="mt-1 text-sm text-muted">恢复码等于账号钥匙，别发到群聊、评论区或公开笔记。</p>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={syncBusy} onClick={() => onPrepareSyncCode({ copy: Boolean(syncCode) })}>
                  <Copy /> {syncCode ? '复制恢复码' : '生成恢复码'}
                </Button>
              </div>
              {syncCode && <textarea className={cn(inputClass, 'mt-3 min-h-20 font-mono text-xs')} value={syncCode} readOnly aria-label="当前账号恢复码" />}
              <div className="mt-4 grid gap-2">
                <textarea
                  className={cn(inputClass, 'min-h-20 font-mono text-xs')}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  placeholder="粘贴另一台设备生成的恢复码"
                  aria-label="粘贴账号恢复码"
                />
                <Button type="button" size="sm" variant="dark" className="justify-self-start" disabled={syncBusy || !recoveryCode.trim()} onClick={onRecover}>
                  <RotateCcw /> 恢复账号
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

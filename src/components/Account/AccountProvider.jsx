import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { clearOfflineRoutebookData, getAuthConfig, getMe, logout as logoutRemote } from '../../lib/accountApi';
import {
  attachAccountToDevice,
  claimSummary,
  clearPendingLogout,
  detachAccountFromDevice,
  executeLogout,
  readPendingLogout,
  retryPendingLogout
} from '../../lib/account';
import { getProfile } from '../../lib/profile';
import { Toast } from '../ui/toast';
// 登录表单只在打开时才下载：首屏不带它和 drawer 依赖。
const LoginSheet = lazy(() => import('./LoginSheet'));

const AccountContext = createContext(/** @type {any} */ (null));

/** @returns {{ mode: string, registration: string, enabled: boolean, required: boolean, emailDelivery?: boolean, account: any, generation: any, ready: boolean, requireLogin: (reason?: string, resume?: () => void) => boolean, openLogin: (view?: string, reason?: string) => void, showRecoveryCodes: (codes: string[]) => void, logout: (options?: { everywhere?: boolean, accountDeleted?: boolean }) => Promise<void>, refresh: () => Promise<void>, setAccount: (account: any) => void }} */
export function useAccount() {
  return useContext(AccountContext) ?? FALLBACK;
}

const FALLBACK = {
  mode: 'access-code',
  registration: 'closed',
  enabled: false,
  required: false,
  emailDelivery: false,
  account: null,
  generation: null,
  ready: true,
  requireLogin: () => true,
  openLogin: () => {},
  showRecoveryCodes: () => {},
  logout: async () => {},
  refresh: async () => {},
  setAccount: () => {}
};

/** @param {{ children: any, onProfileChanged?: (profile: any) => void }} props */
export function AccountProvider({ children, onProfileChanged }) {
  const [config, setConfig] = useState({ mode: 'access-code', registration: 'closed', emailVerificationRequired: true, emailDelivery: false });
  const [account, setAccount] = useState(null);
  const [generation, setGeneration] = useState(null);
  const [ready, setReady] = useState(false);
  const [sheet, setSheet] = useState(/** @type {any} */ (null));
  const [toast, setToast] = useState('');
  const resumeRef = useRef(/** @type {null | (() => void)} */ (null));
  const profileChangedRef = useRef(onProfileChanged);
  profileChangedRef.current = onProfileChanged;
  const accountRef = useRef(account);
  accountRef.current = account;
  const logoutInFlightRef = useRef(0);
  const retryInFlightRef = useRef(/** @type {Promise<void> | null} */ (null));
  const sessionEpochRef = useRef(0);

  const flushPendingLogout = useCallback((fallbackProfileId = '') => {
    if (!readPendingLogout()) return Promise.resolve();
    if (retryInFlightRef.current) return retryInFlightRef.current;
    const epoch = sessionEpochRef.current;
    logoutInFlightRef.current += 1;
    const task = retryPendingLogout({
      accountProfileId: accountRef.current?.profileId || fallbackProfileId || '',
      isCancelled: () => sessionEpochRef.current !== epoch
    })
      .then((result) => {
        if (!result.settled) return;
        setAccount(null);
        setGeneration(null);
        profileChangedRef.current?.(result.profile);
        setToast(result.toast);
      })
      .finally(() => {
        logoutInFlightRef.current = Math.max(0, logoutInFlightRef.current - 1);
        if (retryInFlightRef.current === task) retryInFlightRef.current = null;
      });
    retryInFlightRef.current = task;
    return task;
  }, []);

  const refresh = useCallback(async () => {
    let meAccount = null;
    try {
      const [me, authConfig] = await Promise.all([getMe(), getAuthConfig()]);
      const nextMode = me.mode || authConfig.mode;
      meAccount = me.account ?? null;
      setConfig({
        mode: nextMode,
        registration: authConfig.registration,
        emailVerificationRequired: authConfig.emailVerificationRequired !== false,
        emailDelivery: Boolean(authConfig.emailDelivery)
      });
      const pendingLogout = readPendingLogout();
      setAccount(meAccount);
      setGeneration(meAccount ? (me.generation ?? null) : null);
      // Logged in by cookie but this device's profile is not the account's yet (e.g. storage cleared).
      // Do not re-attach account data to this device while a pending logout is waiting to complete.
      if (meAccount && !pendingLogout && getProfile().id !== meAccount.profileId) {
        const { profile } = await attachAccountToDevice(meAccount);
        profileChangedRef.current?.(profile);
      }
      // Signed out elsewhere (logout everywhere, password reset, account disabled): this device becomes a guest again.
      if (!meAccount && nextMode !== 'access-code' && getProfile().accountUserId) {
        profileChangedRef.current?.(detachAccountFromDevice(getProfile().id));
      }
    } catch {
      // Account status is best effort; the site keeps working for browsing.
    } finally {
      setReady(true);
    }
    if (readPendingLogout()) {
      await flushPendingLogout(meAccount?.profileId || '');
    }
  }, [flushPendingLogout]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onOnline = () => {
      if (readPendingLogout()) {
        void flushPendingLogout(accountRef.current?.profileId || '');
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushPendingLogout]);

  const enabled = config.mode !== 'access-code';
  useEffect(() => {
    if (config.mode !== 'login') return undefined;
    const onLoginRequired = () => {
      // A 401 during an active or retried logout means the session is already gone; never pop the login sheet.
      if (logoutInFlightRef.current > 0 || readPendingLogout()) return;
      if (accountRef.current) {
        // The session ended elsewhere (logout everywhere, password reset): treat this device as signed out.
        setAccount(null);
        setGeneration(null);
        profileChangedRef.current?.(detachAccountFromDevice(accountRef.current?.profileId));
      }
      setSheet((current) => current ?? { view: 'login', reason: '这一步需要登录。登录后再点一次就行。' });
    };
    window.addEventListener('lushu:login-required', onLoginRequired);
    return () => window.removeEventListener('lushu:login-required', onLoginRequired);
  }, [config.mode]);
  const required = config.mode === 'login';

  const requireLogin = useCallback(
    (reason = '', resume) => {
      if (!required || account) return true;
      resumeRef.current = resume ?? null;
      setSheet({ view: 'login', reason });
      return false;
    },
    [required, account]
  );

  const openLogin = useCallback((view = 'login', reason = '') => {
    resumeRef.current = null;
    setSheet({ view, reason });
  }, []);

  const finish = useCallback(() => {
    setSheet(null);
    const resume = resumeRef.current;
    resumeRef.current = null;
    if (resume) window.setTimeout(resume, 0);
  }, []);

  const handleAuthenticated = useCallback(
    async (nextAccount, /** @type {{ recoveryCodes?: string[] }} */ { recoveryCodes } = {}) => {
      sessionEpochRef.current += 1;
      clearPendingLogout();
      const { profile, claim } = await attachAccountToDevice(nextAccount);
      setAccount(nextAccount);
      // Refresh so generation quota lands with the new session.
      try {
        const me = await getMe();
        setGeneration(me.account ? (me.generation ?? null) : null);
      } catch {
        setGeneration(null);
      }
      profileChangedRef.current?.(profile);
      // Verified-email signups can self-reset via email anytime, so let them proceed immediately
      // without the hard-locked recovery-code wall; unverified accounts still see their codes first.
      const needsCodeWall = Boolean(recoveryCodes?.length && !nextAccount?.emailVerified);
      const emailNudge = nextAccount?.emailVerified ? '' : '还没绑定邮箱：去「我的 → 账号」加一个，忘了密码能自己找回';
      const registerOk = recoveryCodes?.length && nextAccount?.emailVerified ? '注册成功。备用恢复码可在「我的 → 账号」生成' : '';
      const summary = [registerOk, claimSummary(claim), needsCodeWall ? '' : emailNudge].filter(Boolean).join('；');
      if (summary) setToast(summary);
      if (needsCodeWall) setSheet({ view: 'codes', codes: recoveryCodes, afterRegister: true });
      else finish();
    },
    [finish]
  );

  const logout = useCallback(async ({ everywhere = false, accountDeleted = false } = {}) => {
    const targetProfileId = accountRef.current?.profileId || '';
    logoutInFlightRef.current += 1;
    try {
      if (accountDeleted) {
        clearPendingLogout();
        await logoutRemote().catch(() => {});
        await clearOfflineRoutebookData();
        const fresh = detachAccountFromDevice(targetProfileId);
        setAccount(null);
        setGeneration(null);
        profileChangedRef.current?.(fresh);
        setToast('已退出登录');
        return;
      }
      const result = await executeLogout({ everywhere, accountProfileId: targetProfileId });
      profileChangedRef.current?.(result.profile);
      if (result.settled) {
        setAccount(null);
        setGeneration(null);
      }
      setToast(result.toast);
    } finally {
      logoutInFlightRef.current = Math.max(0, logoutInFlightRef.current - 1);
    }
  }, []);

  const showRecoveryCodes = useCallback((codes) => setSheet({ view: 'codes', codes, afterRegister: false }), []);

  const value = useMemo(
    () => ({ ...config, enabled, required, account, generation, ready, requireLogin, openLogin, showRecoveryCodes, logout, refresh, setAccount }),
    [config, enabled, required, account, generation, ready, requireLogin, openLogin, showRecoveryCodes, logout, refresh]
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {sheet && (
        <Suspense fallback={null}>
          <LoginSheet
            // The sheet keeps its own view state; remount when it switches to the recovery codes.
            key={sheet.view === 'codes' ? 'codes' : 'auth'}
            initialView={sheet.view}
            reason={sheet.reason}
            codes={sheet.codes}
            afterRegister={sheet.afterRegister}
            registration={config.registration}
            emailVerificationRequired={config.emailVerificationRequired}
            onAuthenticated={handleAuthenticated}
            onCodesConfirmed={finish}
            onClose={() => {
              // Closing the recovery codes after sign-up still continues what the user was doing.
              if (sheet.view === 'codes' && sheet.afterRegister) finish();
              else {
                resumeRef.current = null;
                setSheet(null);
              }
            }}
          />
        </Suspense>
      )}
      <Toast message={toast} onDismiss={() => setToast('')} className="bottom-24 md:bottom-8" />
    </AccountContext.Provider>
  );
}

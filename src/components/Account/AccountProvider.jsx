import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAuthConfig, getMe, logout as logoutRemote, logoutAll as logoutAllRemote } from '../../lib/accountApi';
import { attachAccountToDevice, claimSummary, detachAccountFromDevice } from '../../lib/account';
import { getProfile } from '../../lib/profile';
import { Toast } from '../ui/toast';
import LoginSheet from './LoginSheet';

const AccountContext = createContext(/** @type {any} */ (null));

/** @returns {{ mode: string, registration: string, enabled: boolean, required: boolean, account: any, ready: boolean, requireLogin: (reason?: string, resume?: () => void) => boolean, openLogin: (view?: string, reason?: string) => void, showRecoveryCodes: (codes: string[]) => void, logout: (options?: { everywhere?: boolean }) => Promise<void>, refresh: () => Promise<void>, setAccount: (account: any) => void }} */
export function useAccount() {
  return useContext(AccountContext) ?? FALLBACK;
}

const FALLBACK = {
  mode: 'access-code',
  registration: 'closed',
  enabled: false,
  required: false,
  account: null,
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
  const [config, setConfig] = useState({ mode: 'access-code', registration: 'closed', emailVerificationRequired: true });
  const [account, setAccount] = useState(null);
  const [ready, setReady] = useState(false);
  const [sheet, setSheet] = useState(/** @type {any} */ (null));
  const [toast, setToast] = useState('');
  const resumeRef = useRef(/** @type {null | (() => void)} */ (null));
  const profileChangedRef = useRef(onProfileChanged);
  profileChangedRef.current = onProfileChanged;

  const refresh = useCallback(async () => {
    try {
      const [me, authConfig] = await Promise.all([getMe(), getAuthConfig()]);
      setConfig({
        mode: me.mode || authConfig.mode,
        registration: authConfig.registration,
        emailVerificationRequired: authConfig.emailVerificationRequired !== false
      });
      setAccount(me.account ?? null);
      // Logged in by cookie but this device's profile is not the account's yet (e.g. storage cleared).
      if (me.account && getProfile().id !== me.account.profileId) {
        const { profile } = await attachAccountToDevice(me.account);
        profileChangedRef.current?.(profile);
      }
      // Signed out elsewhere (logout everywhere, password reset, account disabled): this device becomes a guest again.
      if (!me.account && (me.mode || authConfig.mode) !== 'access-code' && getProfile().accountUserId) {
        profileChangedRef.current?.(detachAccountFromDevice());
      }
    } catch {
      // Account status is best effort; the site keeps working for browsing.
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enabled = config.mode !== 'access-code';
  const accountRef = useRef(account);
  accountRef.current = account;
  useEffect(() => {
    if (config.mode !== 'login') return undefined;
    const onLoginRequired = () => {
      if (accountRef.current) {
        // The session ended elsewhere (logout everywhere, password reset): treat this device as signed out.
        setAccount(null);
        profileChangedRef.current?.(detachAccountFromDevice());
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
      const { profile, claim } = await attachAccountToDevice(nextAccount);
      setAccount(nextAccount);
      profileChangedRef.current?.(profile);
      // Accounts without a verified email (signed up before email, or while verification was off) get a nudge, never a block.
      const emailNudge = nextAccount?.emailVerified ? '' : '还没绑定邮箱：去「我的 → 账号」加一个，忘了密码能自己找回';
      const summary = [claimSummary(claim), recoveryCodes?.length ? '' : emailNudge].filter(Boolean).join('；');
      if (summary) setToast(summary);
      if (recoveryCodes?.length) setSheet({ view: 'codes', codes: recoveryCodes, afterRegister: true });
      else finish();
    },
    [finish]
  );

  const logout = useCallback(async ({ everywhere = false } = {}) => {
    try {
      await (everywhere ? logoutAllRemote() : logoutRemote());
    } finally {
      setAccount(null);
      profileChangedRef.current?.(detachAccountFromDevice());
      setToast(everywhere ? '已在所有设备上退出登录' : '已退出登录');
    }
  }, []);

  const showRecoveryCodes = useCallback((codes) => setSheet({ view: 'codes', codes, afterRegister: false }), []);

  const value = useMemo(
    () => ({ ...config, enabled, required, account, ready, requireLogin, openLogin, showRecoveryCodes, logout, refresh, setAccount }),
    [config, enabled, required, account, ready, requireLogin, openLogin, showRecoveryCodes, logout, refresh]
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {sheet && (
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
      )}
      <Toast message={toast} onDismiss={() => setToast('')} className="bottom-24 md:bottom-8" />
    </AccountContext.Provider>
  );
}

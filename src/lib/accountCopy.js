// Plain-language copy for account errors. Server messages are already user-facing; these cover
// network failures and keep wording consistent.
export const PASSWORD_HINT = '至少 8 位，别用生日或手机号';

/** Loose client-side check; the server normalizes and decides. */
export function isEmail(value) {
  return /^[^\s@＠]+[@＠][^\s@＠]+\.[^\s@＠]{2,}$/.test(String(value ?? '').trim());
}

/** How an account is named on screen: masked email, else masked phone. */
export function accountLabel(account) {
  if (!account) return '';
  if (account.emailMasked) return account.emailMasked;
  return account.phoneMasked ? `尾号 ${String(account.phoneMasked).slice(-4)}` : '我的账号';
}

export function isMainlandMobile(value) {
  const digits = String(value ?? '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-().]/g, '')
    .replace(/^(\+86|0086|86(?=\d{11}$))/, '');
  return /^1[3-9]\d{9}$/.test(digits);
}

const COPY = {
  LOGIN_REQUIRED: '请先登录',
  CSRF_REJECTED: '页面停留太久了，刷新一下再试',
  AUTH_BUSY: '登录的人有点多，稍后再试',
  HUMAN_CHECK_INVALID: '安全检查过期了，再点一次',
  MAIL_UNAVAILABLE: '邮件服务还没开通，暂时发不了验证码。可以先用恢复码',
  MAIL_SEND_FAILED: '验证码没发出去，稍后再试'
};

export function authErrorCopy(error) {
  if (error?.name === 'AbortError') return '';
  if (error?.code && COPY[error.code]) return COPY[error.code];
  if (error?.message && error?.status) return error.message;
  return '网络不太稳，没连上服务器。检查网络后再试';
}

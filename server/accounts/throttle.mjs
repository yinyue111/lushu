// Persistent login/registration throttles (survive restarts). Keys never contain raw phones or IPs.
import { createHmac } from 'node:crypto';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { accountStore } from './store.mjs';
import { requestClientKey } from '../auth/request-access.mjs';
import { createHttpError } from '../lib/util.mjs';

const MIN = 60 * 1000;
export const POLICIES = {
  // 5 wrong passwords for one phone → 15 min lock, doubling per repeat, max 24 h.
  phone: { threshold: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 24 * 60 * MIN },
  // 30 failures from one client in 10 min → 30 min lock, doubling, max 24 h.
  ip: { threshold: 30, windowMs: 10 * MIN, lockMs: 30 * MIN, maxLockMs: 24 * 60 * MIN },
  // 5 sign-ups from one client in an hour → 1 h pause.
  register: { threshold: 5, windowMs: 60 * MIN, lockMs: 60 * MIN, maxLockMs: 24 * 60 * MIN },
  // 5 wrong passwords for one email → same as phone.
  email: { threshold: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 24 * 60 * MIN },
  // Mails to one address: 5 per hour, then a 1 h pause (counts every send).
  mailto: { threshold: 5, windowMs: 60 * MIN, lockMs: 60 * MIN, maxLockMs: 24 * 60 * MIN },
  // Mails requested from one client: 20 per hour, then a 1 h pause.
  mailip: { threshold: 20, windowMs: 60 * MIN, lockMs: 60 * MIN, maxLockMs: 24 * 60 * MIN },
  // Wrong email codes for one address: 10 in 15 min → 30 min lock.
  code: { threshold: 10, windowMs: 15 * MIN, lockMs: 30 * MIN, maxLockMs: 24 * 60 * MIN }
};
// From this many recent failures on a client, login also needs the human check.
export const IP_HUMAN_CHECK_AFTER = 5;

const keyHash = (value) => createHmac('sha256', `${PROFILE_ID_SECRET}:auth-throttle`).update(String(value)).digest('hex').slice(0, 40);
export const phoneKey = (phoneHashValue) => `phone:${phoneHashValue.slice(0, 40)}`;
export const ipKey = (req) => `ip:${keyHash(requestClientKey(req))}`;
export const registerKey = (req) => `register:${keyHash(requestClientKey(req))}`;
export const emailKey = (emailHashValue) => `email:${emailHashValue.slice(0, 40)}`;
export const mailtoKey = (emailHashValue) => `mailto:${emailHashValue.slice(0, 40)}`;
export const mailIpKey = (req) => `mailip:${keyHash(requestClientKey(req))}`;
export const codeKey = (emailHashValue) => `code:${emailHashValue.slice(0, 40)}`;

export async function throttleState(key, now = Date.now()) {
  const record = await accountStore().getThrottle(key);
  const lockedUntil = record?.lockedUntil ? Date.parse(record.lockedUntil) : 0;
  const inWindow = record && now - Date.parse(record.windowStartedAt) < POLICIES[key.split(':')[0]].windowMs;
  return { locked: lockedUntil > now, lockedUntil, failures: inWindow ? record.failures : 0, record };
}

export async function recordFailure(key, now = Date.now()) {
  const policy = POLICIES[key.split(':')[0]];
  const { record, failures } = await throttleState(key, now);
  const next = {
    key,
    failures: failures + 1,
    windowStartedAt: failures ? record.windowStartedAt : new Date(now).toISOString(),
    lockedUntil: record?.lockedUntil ?? null,
    lockLevel: record?.lockLevel ?? 0
  };
  if (next.failures >= policy.threshold) {
    next.lockLevel += 1;
    next.lockedUntil = new Date(now + Math.min(policy.lockMs * 2 ** (next.lockLevel - 1), policy.maxLockMs)).toISOString();
    next.failures = 0;
    next.windowStartedAt = new Date(now).toISOString();
  }
  await accountStore().putThrottle(next);
  return next;
}

export async function clearThrottle(key) {
  await accountStore().deleteThrottle(key);
}

export function lockedError(lockedUntil, now = Date.now(), key = '') {
  const minutes = Math.max(1, Math.ceil((lockedUntil - now) / MIN));
  const message = key.startsWith('register:')
    ? `这台设备注册得太频繁了，${minutes} 分钟后再试`
    : key.startsWith('mail')
      ? `验证码发得太频繁了，${minutes} 分钟后再试`
      : key.startsWith('code:')
        ? `验证码错太多次了，${minutes} 分钟后再试`
        : `试错次数太多，${minutes} 分钟后再试，或者用恢复码重设密码`;
  const error = createHttpError(message, 429, 'AUTH_LOCKED');
  /** @type {any} */ (error).retryAfterSeconds = minutes * 60;
  return error;
}

// Process-wide breaker: a burst of failures anywhere makes every login solve the human check.
const recentFailures = [];
export function noteGlobalFailure(now = Date.now()) {
  recentFailures.push(now);
  while (recentFailures.length && now - recentFailures[0] > MIN) recentFailures.shift();
}
export function globalHumanCheckRequired(now = Date.now()) {
  while (recentFailures.length && now - recentFailures[0] > MIN) recentFailures.shift();
  return recentFailures.length >= 300;
}

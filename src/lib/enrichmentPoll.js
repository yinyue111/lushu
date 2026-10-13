// 轮询：5 秒起，每次 ×1.4，最长 30 秒一次，总共最多约 20 分钟；页面在后台时暂停，回到前台立刻查一次。
// 结果在服务端保存：关掉页面核对照样跑完，下次打开直接看到。
export const POLL_START_MS = 5000;
export const POLL_MAX_MS = 30000;
export const POLL_TOTAL_MS = 20 * 60 * 1000;
export const nextPollDelay = (delay) => Math.min(POLL_MAX_MS, Math.round(delay * 1.4));

/** 粗略剩余时间（秒）：按本页观察到的速度外推；还没看到进展时给 null，不编数字。 */
export function estimateRemainingSeconds(samples, progress) {
  if (!progress?.stopsTotal || samples.length < 2) return null;
  const first = samples[0];
  const last = samples.at(-1);
  const doneDelta = last.done - first.done;
  if (doneDelta <= 0) return null;
  const perStop = (last.at - first.at) / 1000 / doneDelta;
  return Math.max(10, Math.round(perStop * Math.max(0, progress.stopsTotal - last.done)));
}

// Header / builder wording for /api/health. `ready` already means "this caller can
// generate now" (model configured AND API access); `access` explains why not.

/**
 * @param {{ ready?: boolean, access?: string, modelReady?: boolean } | null | undefined} health
 * @returns {{ tone: 'ok' | 'warn' | 'off' | 'unknown', label: string }}
 */
export function modelStatusLabel(health) {
  if (!health) return { tone: 'unknown', label: '正在检查 AI' };
  if (health.ready) return { tone: 'ok', label: 'AI 已就绪' };
  if (health.access === 'needs-access-code' && health.modelReady !== false) return { tone: 'warn', label: '需要访问码' };
  if (health.access === 'needs-login' && health.modelReady !== false) return { tone: 'warn', label: '登录后可用 AI' };
  return { tone: 'off', label: 'AI 暂不可用' };
}

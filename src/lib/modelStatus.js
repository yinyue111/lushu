// Header / builder wording for /api/health. `ready` already means "this caller can
// generate now" (model configured AND API access); `access` explains why not.
// Ready state is hidden in the header (not useful to users); only show when blocked.

/**
 * @param {{ ready?: boolean, access?: string, modelReady?: boolean } | null | undefined} health
 * @returns {{ tone: 'ok' | 'warn' | 'off' | 'unknown', label: string, hide?: boolean }}
 */
export function modelStatusLabel(health) {
  if (!health) return { tone: 'unknown', label: '', hide: true };
  if (health.ready) return { tone: 'ok', label: '', hide: true };
  if (health.access === 'needs-access-code' && health.modelReady !== false) return { tone: 'warn', label: '需要访问码' };
  if (health.access === 'needs-login' && health.modelReady !== false) return { tone: 'warn', label: '登录后可用 AI' };
  return { tone: 'off', label: 'AI 暂时不可用，稍后再试' };
}

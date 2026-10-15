import { Suspense, lazy, useState } from 'react';
import { getAdminToken, setAdminToken } from '../lib/legacyApi';
import { Button, Card, Field, Notice, Page, inputClass } from '../ui';

const OpsPage = lazy(() => import('../ops/OpsPage'));

// The pre-console ops tools (POI editor, moderation, CMS…) moved here from the user app. They still talk to
// the script-token endpoints; without a token, only the token card is shown (A3) — no red load errors.
export default function LegacyOpsPage() {
  const [token, setToken] = useState(() => getAdminToken());
  const [draft, setDraft] = useState(() => getAdminToken());

  function applyToken(event) {
    event?.preventDefault?.();
    const next = setAdminToken(draft);
    setToken(next);
  }

  if (!token) {
    return (
      <Page title="旧运维工具" description="过渡期的旧面板，需要先填脚本令牌。">
        <Card title="脚本令牌">
          <p className="mb-3 text-sm text-muted">
            这些是过渡期的旧面板，需要先填脚本令牌（X-Routebook-Admin-Token）。令牌只存在这一页，刷新就清空。
          </p>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={applyToken}>
            <Field label="脚本令牌">
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="X-Routebook-Admin-Token"
                />
              )}
            </Field>
            <Button variant="primary" type="submit" disabled={!String(draft).trim()}>
              进入旧面板
            </Button>
          </form>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="旧运维工具" description="从用户端搬过来的原运维面板，仍使用脚本令牌（X-Routebook-Admin-Token），令牌只存在本页内存，刷新即清空。">
      <Notice tone="warn">这些面板是过渡用的，会逐步并入上面的新页面。</Notice>
      <Suspense fallback={<p className="text-sm text-muted">加载中…</p>}>
        <OpsPage />
      </Suspense>
    </Page>
  );
}

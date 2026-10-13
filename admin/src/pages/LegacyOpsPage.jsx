import { Suspense, lazy } from 'react';
import { Notice, Page } from '../ui';

const OpsPage = lazy(() => import('../ops/OpsPage'));

// The pre-console ops tools (POI editor, moderation, CMS…) moved here from the user app. They still talk to
// the script-token endpoints; the token is typed into the panel and kept in memory for this tab only.
export default function LegacyOpsPage() {
  return (
    <Page title="旧运维工具" description="从用户端搬过来的原运维面板，仍使用脚本令牌（X-Routebook-Admin-Token），令牌只存在本页内存，刷新即清空。">
      <Notice tone="warn">这些面板是过渡用的，会逐步并入上面的新页面。</Notice>
      <Suspense fallback={<p className="text-sm text-muted">加载中…</p>}>
        <OpsPage />
      </Suspense>
    </Page>
  );
}

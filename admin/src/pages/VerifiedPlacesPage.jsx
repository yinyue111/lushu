import { Card, Page } from '../ui';

// Phase 2 placeholder (PRD 第二期): a curated "verified places" library. Phase 1 already stores each manual
// verification in admin_verified_facts (cacheKey, value, sources, verified_by, expires_at = +90 days) and the
// enrichment engine prefers a live verified fact over a fresh search. Browsing / editing that library is phase 2.
export default function VerifiedPlacesPage() {
  return (
    <Page title="地点核对库（二期）" description="下一期开放。">
      <Card>
        <p className="text-sm text-ink-2">
          下一期开放。现在在「纠错队列」里设为人工核实的值，会自动存下来，90 天内有效。
        </p>
        <p className="mt-2 text-sm text-ink-2">第二期计划：按城市浏览已核对地点、到期提醒、批量复核、导入官方来源。范围待产品确认。</p>
      </Card>
    </Page>
  );
}

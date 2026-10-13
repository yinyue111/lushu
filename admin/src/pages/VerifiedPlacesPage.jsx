import { Card, Page } from '../ui';

// Phase 2 placeholder (PRD 第二期): a curated "verified places" library. Phase 1 already stores each manual
// verification in admin_verified_facts (cacheKey, value, sources, verified_by, expires_at = +90 days) and the
// enrichment engine prefers a live verified fact over a fresh search. Browsing / editing that library is phase 2.
export default function VerifiedPlacesPage() {
  return (
    <Page title="已核实地点（二期）" description="这一期还不能在这里浏览或编辑。">
      <Card>
        <p className="text-sm text-ink-2">
          第一期在纠错队列里「设为核实值」时，会把结果按地点（cacheKey）存下来，有效期默认 90
          天（可在配置里改）。有效期内，同一地点的联网补全直接用人工核实的值，并显示「人工核实 · 日期」。
        </p>
        <p className="mt-2 text-sm text-ink-2">第二期计划：按城市浏览已核实地点、到期提醒、批量复核、导入官方来源。范围待产品确认。</p>
      </Card>
    </Page>
  );
}

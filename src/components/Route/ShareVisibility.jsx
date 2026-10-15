import { useId, useState } from 'react';
import { Globe2, Link2, Lock, ShieldAlert } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';

/**
 * "谁能看到这条路书": private / unlisted friend link / public listing. Routebooks built from
 * imported third-party guides cannot be publicly listed without the original author's
 * authorization (server policy IMPORTED_ROUTEBOOK_PUBLIC_POLICY); this explains why.
 * @param {Record<string, any>} props
 */
export default function ShareVisibility({
  routebook,
  publication,
  shareUrl,
  friendUrl,
  busy,
  onCreateFriendLink,
  onCopyFriendLink,
  onRevokeFriendLink,
  onClaimAuthorship
}) {
  const headingId = useId();
  const claimId = useId();
  const [claimConfirmed, setClaimConfirmed] = useState(false);
  const pendingReview = routebook.publishStatus === 'pending_review';
  const current = shareUrl ? 'public' : friendUrl ? 'friend' : 'private';
  const claimed = routebook.authorshipClaim?.claimed === true || publication?.claimedAuthorship === true;

  return (
    <section aria-labelledby={headingId} className="mb-4 grid gap-2.5" data-testid="share-visibility">
      <h3 id={headingId} className="text-base font-extrabold">
        谁能看到这条路书
      </h3>
      {publication?.imported && (
        <p className="flex items-start gap-2 rounded-tile bg-lemon-soft px-3 py-2.5 text-sm font-semibold text-lemon-ink">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{publication.reason || '这条路书来自导入的第三方攻略，取得原作者授权前只能自己看或发朋友链接。'}</span>
        </p>
      )}
      <ul className="grid gap-2">
        <Option icon={Lock} title="仅自己" active={current === 'private'}>
          保存在你的账号和这台设备上，别人看不到。
        </Option>
        <Option icon={Link2} title="朋友链接" active={current === 'friend'} badge="不公开">
          <span className="block">只有拿到链接的人能打开；不会出现在公开列表，也不会被搜索引擎收录。随时可以停用。</span>
          {friendUrl && <span className="mt-2 block rounded-tile bg-canvas px-2.5 py-1.5 font-mono text-xs break-all text-ink-2">{friendUrl}</span>}
          <span className="mt-2 flex flex-wrap gap-2">
            {friendUrl ? (
              <>
                <Button size="sm" variant="outline" onClick={onCopyFriendLink} disabled={busy}>
                  复制朋友链接
                </Button>
                <Button size="sm" variant="ghost" onClick={onRevokeFriendLink} disabled={busy}>
                  停用链接
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={onCreateFriendLink} disabled={busy || Boolean(shareUrl)}>
                生成朋友链接
              </Button>
            )}
          </span>
        </Option>
        <Option
          icon={Globe2}
          title="公开发布"
          active={current === 'public'}
          badge={shareUrl ? '已公开' : pendingReview ? '已申请公开' : publication?.publicAllowed === false ? '暂不可用' : ''}
          muted={publication?.publicAllowed === false && !shareUrl}
        >
          {publication?.publishingDisabled ? (
            <span className="block">{publication.reason || '暂不开放公开发布。路书可以自己用，或生成朋友链接只发给朋友。'}</span>
          ) : publication?.publicAllowed === false ? (
            <>
              <span className="block">需要原作者授权：导入的攻略属于原作者，平台不会把它公开展示在城市列表和搜索里。</span>
              {publication.canClaimAuthorship && !claimed && !pendingReview && (
                <span className="mt-2 grid gap-2">
                  <label htmlFor={claimId} className="flex items-start gap-2 text-sm text-ink-2">
                    <input
                      id={claimId}
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-primary"
                      checked={claimConfirmed}
                      onChange={(event) => setClaimConfirmed(event.target.checked)}
                    />
                    <span>我就是原作者，或已取得原作者的公开授权（运营会核实，核实前不会公开）。</span>
                  </label>
                  <span>
                    <Button size="sm" variant="outline" disabled={!claimConfirmed || busy} onClick={onClaimAuthorship}>
                      以原作者身份申请公开
                    </Button>
                  </span>
                </span>
              )}
              {(claimed || pendingReview) && <span className="mt-1 block">已申请公开，确认授权后才会公开。</span>}
            </>
          ) : (
            <span className="block">申请公开：确认来源授权、查过路线后，会出现在城市列表和搜索里。</span>
          )}
        </Option>
      </ul>
    </section>
  );
}

/** @param {Record<string, any>} props */
function Option({ icon: Icon, title, active, badge = '', muted = false, children }) {
  return (
    <li className={cn('flex gap-3 rounded-tile border p-3', active ? 'border-primary bg-primary-soft/40' : 'border-line bg-white')}>
      <span
        className={cn('grid size-9 shrink-0 place-items-center rounded-full', muted ? 'bg-canvas text-muted' : 'bg-sky-soft text-sky-ink')}
        aria-hidden="true"
      >
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1 text-sm text-ink-2">
        <p className="flex flex-wrap items-center gap-2">
          <strong className="text-copy font-extrabold text-ink">{title}</strong>
          {active && <span className="rounded-full bg-primary-strong px-2 py-0.5 text-xs font-bold text-white">当前</span>}
          {badge && !active && <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-bold text-ink-2">{badge}</span>}
        </p>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}

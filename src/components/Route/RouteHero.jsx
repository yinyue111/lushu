import { ArrowLeft, Bell, Check, ClipboardCopy, Copy, Heart, MapPin, MoreHorizontal, Navigation, Share2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu';
import { cn } from '../ui/cn';
import { publishStatusLabel } from '../ui/labels';
import { CITY_SCENE, cityCover, heroImageProps } from '../visual/theme';
import { SceneBadge, SceneImage } from '../visual/SceneImage';
import AigcChip from './AigcChip';
import { aigcMetadata } from '../../lib/aigc.js';
import { useAccount } from '../Account/AccountProvider';
import { accountLabel } from '../../lib/accountCopy';
import { publicCreatorName } from '../../lib/creatorName.js';
import { TAP_TARGET } from '../ui/tap-target.js';

/**
 * Full-bleed cover. Trusted cities use bundled photography; other cities get a
 * generic AI-generated city scene labelled 「城市示意图」 (never a borrowed photo of a different place).
 */
export default function RouteHero({
  routebook,
  dayCount,
  stopCount,
  trustState,
  isOwner,
  liked,
  canEdit,
  saving,
  actions,
  onBack,
  onStartTrip,
  onCustomize,
  onShare
}) {
  const { account } = useAccount();
  const cover = cityCover(routebook.city);
  // U18: public views show a byline only for a real nickname; never a placeholder, never the masked account.
  const nickname = publicCreatorName(routebook.creator?.name);
  const ownLabel = isOwner ? nickname || (account ? accountLabel(account) : '') || '我' : null;
  const creatorName = isOwner ? ownLabel : nickname;
  const showNicknameHint = isOwner && !nickname;
  const updated = formatShortDate(routebook.updatedAt || routebook.createdAt);
  // 合规：只保留一个显式 AI 标识。AI 生成的路书由 AigcChip 统一标注（覆盖文字与示意配图，
  // 标签叠在配图上、紧邻标题）；非 AI 内容才单独给示意图打标。见 round2/AI标识合并说明.md。
  const aiGenerated = aigcMetadata(routebook).generated;
  const TrustIcon = trustState.tone === 'trial' ? TriangleAlert : ShieldCheck;

  return (
    <section className="relative isolate overflow-hidden bg-[#1c2230] text-white">
      {cover ? (
        <img
          {...heroImageProps(cover)}
          alt=""
          className="absolute inset-0 -z-20 size-full scale-[1.04] bg-[#1c2230] object-cover object-[center_62%]"
          fetchPriority="high"
        />
      ) : (
        <div className="absolute inset-0 -z-20 bg-[radial-gradient(120%_90%_at_10%_0%,#ff9a3c_0%,#e8553d_38%,#7c3aed_100%)]" aria-hidden="true">
          <MapPin className="absolute top-8 right-[8%] size-56 text-white/10" strokeWidth={1} />
          <SceneImage
            src={CITY_SCENE}
            loading="eager"
            fetchPriority="high"
            className="absolute inset-0 size-full object-cover object-[center_40%]"
            badge={aiGenerated ? null : <SceneBadge className="top-16 right-3 lg:top-auto lg:right-5 lg:bottom-5">城市示意图 · AI 生成</SceneBadge>}
          />
          <span className="absolute right-[6%] bottom-6 text-watermark leading-none font-black tracking-tight text-white/10 select-none">{routebook.city}</span>
        </div>
      )}
      <div
        className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.32)_0%,rgba(10,12,16,.04)_32%,rgba(10,12,16,.62)_68%,rgba(10,12,16,.86)_100%)]"
        aria-hidden="true"
      />

      {/* Top controls */}
      <div className="absolute inset-x-3.5 top-[calc(12px+env(safe-area-inset-top))] flex items-center justify-between lg:inset-x-8 lg:top-5">
        <Button variant="light" size="icon" className="lg:h-10 lg:w-auto lg:gap-1.5 lg:px-4 lg:text-sm" onClick={onBack} aria-label="返回">
          <ArrowLeft />
          <span className="hidden lg:inline">返回</span>
        </Button>
        <div className="flex gap-2.5 lg:hidden">
          <Button variant="light" size="icon" onClick={onShare} aria-label="分享">
            <Share2 />
          </Button>
          <Button
            variant="light"
            size="icon"
            onClick={actions.favoriteRoute}
            aria-label={liked ? '已收藏' : '收藏'}
            className={cn(liked && 'text-primary-strong')}
          >
            <Heart className={cn(liked && 'animate-pop fill-current')} />
          </Button>
        </div>
      </div>

      <div className="mx-auto flex min-h-[380px] max-w-[1376px] items-end gap-8 px-[18px] pt-24 pb-11 lg:min-h-[400px] lg:px-8 lg:pb-8">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Chip tone="lemon">
              <MapPin /> {routebook.city || '目的地'}
            </Chip>
            <Chip tone="glass">
              {dayCount} 天 · {stopCount} 站
            </Chip>
            {!(aiGenerated && trustState.tone === 'trial') && (
              <Chip tone="glass">
                <TrustIcon /> {trustState.shortLabel}
              </Chip>
            )}
            <AigcChip routebook={routebook} draft={trustState.tone === 'trial'} withImage={!cover} />
            {routebook.routingWarning?.unverifiedLegs > 0 && (
              // Only present on owner/ops reads: a re-check found unverified legs but the
              // routebook stays published (re-checks never unpublish).
              <Chip tone="lemon" title={routebook.routingWarning.message} data-testid="routing-warning-chip">
                <TriangleAlert aria-hidden="true" /> {routebook.routingWarning.unverifiedLegs} 段路线还没查
                <span className="sr-only">：{routebook.routingWarning.message}</span>
              </Chip>
            )}
          </div>
          <h1
            className={cn(
              'max-w-[860px] leading-tight font-extrabold tracking-tight [overflow-wrap:anywhere] [text-shadow:0_2px_18px_rgba(0,0,0,.25)] [word-break:keep-all] lg:leading-[1.18]',
              // Long (user/model written) titles step down a size so they don't fill the photo.
              String(routebook.title ?? '').length > 26 ? 'text-title lg:text-display' : 'text-display-sm lg:text-display-lg'
            )}
          >
            {routebook.title}
          </h1>
          {routebook.summary && (
            <p className="mt-2.5 hidden max-w-[720px] text-copy leading-relaxed text-white/90 [text-shadow:0_1px_10px_rgba(0,0,0,.35)] sm:line-clamp-2 lg:text-lead lg:leading-relaxed">
              {routebook.summary}
            </p>
          )}
          {creatorName && (
            <div className="mt-4 flex items-center gap-2.5 text-sm text-white/92 lg:text-copy" data-testid="route-byline">
              <span className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-white bg-gradient-to-br from-lemon to-[#ff9a3c] text-sm font-extrabold text-ink">
                {String(creatorName).slice(0, 1)}
              </span>
              <span className="min-w-0 truncate">
                <b className="text-white">{creatorName}</b>
                {isOwner && <span> · {publishStatusLabel(routebook.publishStatus)}</span>}
                {updated && <span className="hidden sm:inline"> · {updated} 更新</span>}
              </span>
            </div>
          )}
          {showNicknameHint && (
            <a
              href="/my#account"
              className={`${TAP_TARGET} mt-1.5 inline-block text-meta text-white/85 underline underline-offset-2 hover:text-white`}
              data-testid="nickname-hint"
            >
              设个昵称，分享时会显示
            </a>
          )}
        </div>

        <div className="hidden w-[300px] shrink-0 flex-col gap-2.5 lg:flex">
          <Button variant="primary" size="lg" className="h-14 text-title-xs" onClick={onStartTrip}>
            <Navigation /> 开始出行
          </Button>
          <div className="flex gap-2.5">
            {canEdit ? (
              <>
                <Button variant="light" className="flex-1" onClick={actions.saveCurrentRoutebook} disabled={saving}>
                  <Check /> {saving ? '保存中…' : '保存到我的路书'}
                </Button>
              </>
            ) : (
              <Button variant="light" className="flex-1" onClick={onCustomize}>
                <Copy /> 复制一份改成我的
              </Button>
            )}
            <Button
              variant="light"
              size="icon"
              onClick={actions.favoriteRoute}
              aria-label={liked ? '已收藏' : '收藏'}
              className={cn(liked && 'text-primary-strong')}
            >
              <Heart className={cn(liked && 'animate-pop fill-current')} />
            </Button>
            <MoreMenu actions={actions} onShare={onShare} onCustomize={onCustomize} canEdit={canEdit} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** @param {Record<string, any>} props */
export function MoreMenu({ actions, onShare, onCustomize, canEdit, triggerClassName, triggerLabel = '' }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="light" size={triggerLabel ? 'md' : 'icon'} aria-label="更多操作" className={triggerClassName}>
          <MoreHorizontal />
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onShare}>
          <Share2 /> 分享给朋友
        </MenuItem>
        <MenuItem onSelect={actions.copyRoute}>
          <ClipboardCopy /> 复制行程文字
        </MenuItem>
        <MenuItem onSelect={actions.saveTripReminder}>
          <Bell /> 出发提醒
        </MenuItem>
        {canEdit && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={onCustomize}>
              <Copy /> 整本重生成（耗 1 次）
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function formatShortDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

import {
  Baby,
  CalendarClock,
  Compass,
  FileSearch,
  MapPinned,
  MessageSquareText,
  Plus,
  Repeat2,
  Route as RouteIcon,
  ShieldCheck,
  Sparkles,
  Ticket,
  Umbrella,
  Wallet,
  WalletCards,
  Footprints,
  Undo2,
  Redo2,
  Trash2,
  Bus
} from 'lucide-react';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { predictionAverage, productLinkLabel } from './routebookModel';
import { useVisibleOnce } from '../../lib/useVisibleOnce';

const OK_STATES = /通过|已查过|可执行|已更新|已应用|充足|正常|低/;
const WARN_STATES = /复核|还没查|偏紧|缓冲|无数据|偏远|待|超|风险|高|未|冲突|不满足/;

function stateTone(state) {
  const text = String(state ?? '');
  if (OK_STATES.test(text)) return 'ok';
  if (WARN_STATES.test(text)) return 'warn';
  return 'sky';
}

function checkIcon(label) {
  const text = String(label ?? '');
  if (/节奏|密度/.test(text)) return Compass;
  if (/预算|费用/.test(text)) return Wallet;
  if (/绕路|动线|转场|^路线$/.test(text)) return Repeat2;
  if (/营业|时间/.test(text)) return CalendarClock;
  if (/定位|坐标/.test(text)) return MapPinned;
  if (/AI|校验/.test(text)) return ShieldCheck;
  return RouteIcon;
}

/** "出发前看一眼" — validations, source analysis and feedback, as friendly tiles. */
export function RoutePreflight({ routebook }) {
  const checks = (routebook.validations ?? []).slice(0, 6);
  const source = routebook.sourceSummary?.sourceCount > 0 ? routebook.sourceSummary : null;
  const feedback = routebook.feedbackSummary;
  const aiNotes = Array.isArray(routebook.aiNotes) ? routebook.aiNotes.slice(0, 6) : [];
  if (!checks.length && !source && !feedback && !aiNotes.length) return null;
  const warnCount = checks.filter((check) => stateTone(check.state) === 'warn').length;
  const summaryBits = [
    checks.length ? `${checks.length} 项检查` : '',
    warnCount ? `${warnCount} 项待留意` : '',
    aiNotes.length ? `${aiNotes.length} 条 AI 提示` : ''
  ].filter(Boolean);
  return (
    <section aria-labelledby="preflight-title">
      <details className="group mt-7 lg:mt-8" open={warnCount === 0 && checks.length <= 2}>
        <summary
          id="preflight-title"
          className="flex cursor-pointer list-none items-baseline justify-between gap-3 text-title-sm font-extrabold tracking-tight lg:text-title [&::-webkit-details-marker]:hidden"
        >
          <span>出发前看一眼</span>
          <span className="text-meta font-semibold text-muted group-open:hidden">{summaryBits.join(' · ') || '展开详情'}</span>
          <span className="hidden text-meta font-semibold text-muted group-open:inline">收起</span>
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {checks.map((check) => {
            const Icon = checkIcon(check.label);
            return (
              <CheckTile key={check.id || check.label} icon={Icon} title={check.label} chip={check.state} tone={stateTone(check.state)}>
                {check.detail}
              </CheckTile>
            );
          })}
          {source && (
            <CheckTile icon={FileSearch} title="攻略来源" chip={`${source.sourceCount} 条`} tone="sky">
              来源预测均分 {predictionAverage(source)}，只辅助解析，不代表有人真的去过。
              {Array.isArray(source.platforms) && source.platforms.filter(Boolean).length ? ` 来自：${source.platforms.filter(Boolean).join('、')}。` : ''}
            </CheckTile>
          )}
          {feedback && (feedback.attestedCheckinCount || feedback.correctionCount || feedback.feedbackCount) > 0 && (
            <CheckTile icon={MessageSquareText} title="走过的人怎么说" chip={`${feedback.attestedCheckinCount || 0} 次打卡`} tone="ok">
              到达率 {feedback.completionRate || 0}% · 踩坑率 {feedback.pitfallRate || 0}% · 纠错 {feedback.correctionCount || 0} 条。
            </CheckTile>
          )}
        </div>
        {aiNotes.length > 0 && (
          <div className="mt-3 rounded-card border border-dashed border-line-strong p-3.5" role="group" aria-labelledby="ai-notes-title">
            <h3 id="ai-notes-title" className="flex items-center gap-2 text-base font-extrabold">
              <Sparkles className="size-[18px]" aria-hidden="true" /> AI 提示
              <Chip size="sm" tone="warn" className="h-6 text-meta">
                未核对
              </Chip>
            </h3>
            <p className="mt-0.5 text-meta text-muted">生成路线时写下的提醒，系统没有核对过，仅供参考。</p>
            <ul className="mt-2 grid gap-1.5 text-sm text-ink-2">
              {aiNotes.map((note) => (
                <li key={`${note.label}-${note.detail}`}>
                  <b className="font-bold">{note.label}：</b>
                  {note.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </section>
  );
}

/** @param {Record<string, any>} props */
function CheckTile({ icon: Icon, title, chip, tone, children }) {
  return (
    <div className="grid grid-cols-[44px_1fr] items-start gap-3 rounded-card bg-canvas p-3.5">
      <span className="grid size-11 place-items-center rounded-tile bg-white text-ink-2">
        <Icon className="size-[22px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <b className="flex items-center justify-between gap-2 text-base">
          <span className="min-w-0">{title}</span>
          {chip && (
            <Chip size="sm" tone={tone} className="h-6 text-meta">
              {chip}
            </Chip>
          )}
        </b>
        <p className="mt-0.5 text-sm text-muted">{children}</p>
      </div>
    </div>
  );
}

const MODES = [
  { mode: '少走路', icon: Footprints },
  { mode: '雨天', icon: Umbrella },
  { mode: '低预算', icon: WalletCards },
  { mode: '亲子', icon: Baby }
];

/** Owner-only editing strip: two primary actions, everything else folded into 更多改法. */
export function EditToolbar({
  routebook,
  saving,
  variantState,
  syncLabel,
  canUndo,
  canRedo,
  onMode,
  onAddStop,
  onApplyVariant,
  onUndo,
  onRedo,
  onStripModel,
  onOpenChat,
  onPatchDay,
  onTransportPref,
  activeDay
}) {
  const variants = (routebook.variants ?? []).slice(0, 4);
  const hasModel = (routebook.stops ?? []).some((s) => s?.provenance?.origin === 'model');
  const dirty = /未保存/.test(syncLabel || '');
  return (
    <section aria-labelledby="edit-toolbar-title" className="mt-6 rounded-card border border-line bg-white p-3.5 shadow-card lg:mt-7">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="edit-toolbar-title" className="text-copy font-extrabold text-ink">
          改路线
        </h2>
        {syncLabel && (
          <span role="status" className={cn('rounded-full px-2 py-0.5 text-meta', dirty ? 'bg-lemon-soft text-lemon-ink' : 'bg-canvas text-muted')}>
            {syncLabel}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" disabled={!canUndo || saving} onClick={onUndo}>
            <Undo2 /> 撤销
          </Button>
          <Button size="sm" variant="ghost" disabled={!canRedo || saving} onClick={onRedo} aria-label="重做">
            <Redo2 />
          </Button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="dark" onClick={onOpenChat} disabled={saving}>
          <MessageSquareText /> 用一句话改
        </Button>
        <Button variant="outline" onClick={onAddStop} disabled={saving}>
          <Plus /> 加一站
        </Button>
      </div>
      <p className="mt-2 text-meta text-muted">换店、删站：点每一站右边的「⋮」。</p>
      <details className="group mt-2 rounded-tile bg-canvas px-3 py-2">
        <summary className="cursor-pointer list-none text-meta font-semibold text-ink-2 [&::-webkit-details-marker]:hidden">
          更多改法 <span className="font-normal text-muted">· 一键重排、地铁优先、AI 重排</span>
        </summary>
        <p className="mt-2 text-meta font-semibold text-ink-2">一键重排（按规则，不耗次数）</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {MODES.map(({ mode, icon: Icon }) => (
            <Button key={mode} size="sm" onClick={() => onMode(mode)} disabled={saving}>
              <Icon /> {mode}
            </Button>
          ))}
          <Button size="sm" onClick={() => onTransportPref?.('transit')} disabled={saving}>
            <Bus /> 地铁优先
          </Button>
        </div>
        <p className="mt-3 text-meta font-semibold text-ink-2">让 AI 改（耗 1 次 AI 重排次数）</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onPatchDay?.(activeDay)} disabled={saving}>
            <Sparkles /> AI 重排这一天
          </Button>
          {hasModel && (
            <Button size="sm" variant="outline" onClick={onStripModel} disabled={saving}>
              <Trash2 /> 去掉 AI 加的站
            </Button>
          )}
        </div>
        <p className="mt-3 text-meta text-muted">想从头来过？右上「⋯」里的「整本重生成」会耗 1 次生成次数。</p>
      </details>
      {(variants.length > 0 || variantState) && (
        <div className="mt-3">
          <p className="mb-1.5 text-meta font-semibold text-ink-2">之前的重排版本 · 点一下换回去</p>
          {variantState && (
            <p className="mb-2 text-meta text-muted" role="status">
              {variantState}
            </p>
          )}
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {variants.map((variant) => (
              <button
                type="button"
                key={variant.id}
                onClick={() => onApplyVariant(variant)}
                className={cn(
                  'w-52 shrink-0 rounded-tile border border-line bg-canvas p-3 text-left',
                  routebook.activeVariantId === variant.id && 'border-transparent bg-primary-soft shadow-[0_0_0_2px_var(--color-primary)]'
                )}
              >
                <b className="block text-copy">{variant.label}</b>
                <span className="line-clamp-2 block text-meta text-muted">{variant.summary}</span>
                <small className="mt-1 block text-xs text-muted">{variant.stops?.length ?? 0} 站</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** External search entries (F18: not verified products) — product cards (analytics preserved via onClick). */
export function RouteProducts({ products, onClick, onVisible = undefined }) {
  if (!products.length) return null;
  return (
    <section aria-labelledby="products-title">
      <h2 id="products-title" className="mt-7 mb-3 text-xl font-extrabold tracking-tight lg:mt-8 lg:text-2xl">
        顺路搜索入口（未核对）
      </h2>
      <div className="no-scrollbar -mx-4 flex gap-2.5 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0">
        {products.map((item, index) => (
          <RouteProductCard
            key={item.id || item.url || `${item.provider}-${item.title}-${index}`}
            item={item}
            onClick={() => onClick(item)}
            onVisible={onVisible ? () => onVisible(item, index) : undefined}
          />
        ))}
      </div>
    </section>
  );
}

/** @param {{ item: any, onClick: () => void, onVisible?: () => void }} props */
function RouteProductCard({ item, onClick, onVisible }) {
  const ref = useVisibleOnce(() => onVisible?.());
  return (
    <button
      ref={/** @type {any} */ (ref)}
      type="button"
      onClick={onClick}
      className="w-64 shrink-0 rounded-card border border-line bg-white p-3.5 text-left shadow-card transition-transform duration-300 ease-(--ease-spring) hover:-translate-y-0.5 sm:w-auto"
    >
      <Chip size="sm" tone="sky">
        <Ticket /> {item.type}
      </Chip>
      <b className="mt-2 line-clamp-2 block text-copy leading-snug">{item.title}</b>
      <small className="mt-1 block text-meta text-muted">{[item.poi, item.price, productLinkLabel(item)].filter(Boolean).join(' · ')}</small>
    </button>
  );
}

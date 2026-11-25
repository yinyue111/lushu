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
import { predictionAverage, productLinkLabel } from './routebookModel';
import { useVisibleOnce } from '../../lib/useVisibleOnce';
import { validationFallbackDetail, validationStateTone } from '../../lib/validationCopy';

function checkIcon(label, id) {
  const text = `${id ?? ''} ${label ?? ''}`;
  if (/tempo|节奏|密度/.test(text)) return Compass;
  if (/预算|费用/.test(text)) return Wallet;
  if (/routing|detour|transport|绕路|动线|转场|^路线$/.test(text)) return Repeat2;
  if (/hours|time-of-day|营业|时间|时段/.test(text)) return CalendarClock;
  if (/geo|定位|坐标/.test(text)) return MapPinned;
  if (/source-trust|AI|核对|来源/.test(text)) return ShieldCheck;
  return RouteIcon;
}

/** "出发前看一眼" — validations, source analysis and feedback, as friendly tiles. */
export function RoutePreflight({ routebook }) {
  const checks = (routebook.validations ?? []).slice(0, 9);
  const source = routebook.sourceSummary?.sourceCount > 0 ? routebook.sourceSummary : null;
  const feedback = routebook.feedbackSummary;
  const aiNotes = Array.isArray(routebook.aiNotes) ? routebook.aiNotes.slice(0, 6) : [];
  if (!checks.length && !source && !feedback && !aiNotes.length) return null;
  const routingUnchecked = checks.some((check) => check.id === 'edit-routing' && check.state === '还没查');
  const isDeferredSecondaryCheck = (check) => routingUnchecked && (check.id === 'edit-tempo' || check.id === 'edit-detour') && check.state === '还没查';
  const attentionChecks = checks.filter((check) => validationStateTone(check.state) === 'warn' && !isDeferredSecondaryCheck(check));
  const passedChecks = checks.filter((check) => validationStateTone(check.state) !== 'warn' || isDeferredSecondaryCheck(check));
  const warnCount = attentionChecks.length;
  const summaryBits = [
    warnCount ? `${warnCount} 项待留意` : checks.length ? `全部 ${checks.length} 项正常` : '',
    aiNotes.length ? `${aiNotes.length} 条 AI 提示` : ''
  ].filter(Boolean);
  return (
    <section aria-labelledby="preflight-title">
      <details className="group mt-7 rounded-card border border-line bg-canvas/50 px-4 py-2 lg:mt-8">
        <summary
          id="preflight-title"
          className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-copy font-extrabold tracking-tight lg:text-title-xs [&::-webkit-details-marker]:hidden"
        >
          <span>诊断与补充说明</span>
          <span className="text-meta font-semibold text-muted group-open:hidden">{summaryBits.join(' · ') || '展开详情'}</span>
          <span className="hidden text-meta font-semibold text-muted group-open:inline">收起</span>
        </summary>
        {attentionChecks.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {attentionChecks.map((check) => {
              const Icon = checkIcon(check.label, check.id);
              return (
                <CheckTile key={check.id || check.label} icon={Icon} title={check.label} chip={check.state} tone="warn">
                  {validationFallbackDetail(check)}
                </CheckTile>
              );
            })}
          </div>
        )}
        {(passedChecks.length > 0 || source || feedback) &&
          (attentionChecks.length > 0 ? (
            <details className="mt-3 rounded-card border border-line bg-white px-3.5 py-1">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-muted [&::-webkit-details-marker]:hidden">
                <span>{passedChecks.length > 0 ? `其余 ${passedChecks.length} 项常规与补充说明` : '攻略来源与同行反馈'}</span>
                <span className="text-meta">展开查看</span>
              </summary>
              <div className="mt-2 pb-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {passedChecks.map((check) => {
                  const Icon = checkIcon(check.label, check.id);
                  return (
                    <CheckTile key={check.id || check.label} icon={Icon} title={check.label} chip={check.state} tone={validationStateTone(check.state)}>
                      {validationFallbackDetail(check)}
                    </CheckTile>
                  );
                })}
                {source && (
                  <CheckTile icon={FileSearch} title="攻略来源" chip={`${source.sourceCount} 条`} tone="sky">
                    来源预测均分 {predictionAverage(source)}，只辅助解析，不代表有人真的去过。
                    {Array.isArray(source.platforms) && source.platforms.filter(Boolean).length
                      ? ` 来自：${source.platforms.filter(Boolean).join('、')}。`
                      : ''}
                  </CheckTile>
                )}
                {feedback && (feedback.attestedCheckinCount || feedback.correctionCount || feedback.feedbackCount) > 0 && (
                  <CheckTile icon={MessageSquareText} title="走过的人怎么说" chip={`${feedback.attestedCheckinCount || 0} 次打卡`} tone="ok">
                    到达率 {feedback.completionRate || 0}% · 踩坑率 {feedback.pitfallRate || 0}% · 纠错 {feedback.correctionCount || 0} 条。
                  </CheckTile>
                )}
              </div>
            </details>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {passedChecks.map((check) => {
                const Icon = checkIcon(check.label, check.id);
                return (
                  <CheckTile key={check.id || check.label} icon={Icon} title={check.label} chip={check.state} tone={validationStateTone(check.state)}>
                    {validationFallbackDetail(check)}
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
          ))}
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
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 id="edit-toolbar-title" className="sr-only">
          改路线
        </h2>
        <Button size="sm" variant="dark" onClick={onOpenChat} disabled={saving}>
          <MessageSquareText /> 用一句话改
        </Button>
        <Button size="sm" variant="outline" onClick={onAddStop} disabled={saving}>
          <Plus /> 加一站
        </Button>
        {syncLabel && dirty && (
          <span role="status" className="rounded-full bg-lemon-soft px-2 py-0.5 text-xs font-semibold text-lemon-ink">
            {syncLabel}
          </span>
        )}
        <div className="ml-auto flex gap-0.5">
          <Button size="sm" variant="ghost" disabled={!canUndo || saving} onClick={onUndo} aria-label="撤销">
            <Undo2 />
          </Button>
          <Button size="sm" variant="ghost" disabled={!canRedo || saving} onClick={onRedo} aria-label="重做">
            <Redo2 />
          </Button>
        </div>
      </div>
      <details className="group mt-1.5 rounded-tile bg-canvas px-3 py-0.5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-semibold text-ink-2 sm:min-h-9 [&::-webkit-details-marker]:hidden">
          更多改法 <span className="font-normal text-muted">· 少走路、雨天、地铁优先、AI 重排</span>
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
                className={`w-52 shrink-0 rounded-tile border border-line bg-canvas p-3 text-left ${
                  routebook.activeVariantId === variant.id ? 'border-transparent bg-primary-soft shadow-[0_0_0_2px_var(--color-primary)]' : ''
                }`}
              >
                <b className="block truncate text-sm font-extrabold">{variant.label || '重排版本'}</b>
                <span className="mt-0.5 block text-meta text-muted">{variant.summary || ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );

  return (
    <section aria-labelledby="edit-toolbar-title" className="mt-3 rounded-card border border-line bg-white px-3 py-2.5 shadow-card lg:mt-5">
      {body}
    </section>
  );
}

/** External search entries (F18: not verified products) — product cards (analytics preserved via onClick). */
export function RouteProducts({ products, onClick, onVisible = undefined }) {
  if (!products.length) return null;
  return (
    <section aria-labelledby="products-title">
      <h2 id="products-title" className="mt-7 mb-3 text-xl font-extrabold tracking-tight lg:mt-8 lg:text-2xl">
        顺路可订（外部平台）
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
      className="w-64 shrink-0 rounded-card border border-line bg-white p-3.5 text-left shadow-card transition-shadow duration-200 hover:shadow-pop sm:w-auto"
    >
      <Chip size="sm" tone="sky">
        <Ticket /> {item.type}
      </Chip>
      <b className="mt-2 line-clamp-2 block text-copy leading-snug">{item.title}</b>
      <small className="mt-1 block text-meta text-muted">{[item.poi, item.price, productLinkLabel(item)].filter(Boolean).join(' · ')}</small>
    </button>
  );
}

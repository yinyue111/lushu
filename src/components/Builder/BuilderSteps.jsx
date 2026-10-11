import { GENERATION_MODES } from '../../lib/generationModes';
import { AlertCircle, CalendarDays, Check, Home, ImageUp, Link, Loader2, MapPin, Plus, Train, X } from 'lucide-react';
import { trustedCities } from '../../lib/content';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { cn } from '../ui/cn';
import { cityCover, smallImage } from '../visual/theme';
import { averageSourcePrediction, budgetHint, budgetValueForLabel, importStatusLabel, sourcePredictionTone, sourcePredictionValue } from './builderModel';

const TONES = {
  sky: 'bg-sky-soft text-sky-ink',
  warn: 'bg-lemon-soft text-lemon-ink',
  bad: 'bg-primary-soft text-primary-strong',
  ok: 'bg-success-soft text-success-ink'
};

/** @param {Record<string, any>} props */
export function Stepper({ labels, step }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="创建路书进度">
      {labels.map((label, i) => {
        const state = i === step ? 'current' : i < step ? 'done' : 'todo';
        return (
          <li key={label} aria-current={state === 'current' ? 'step' : undefined} className="min-w-0">
            <span className={cn('block h-1.5 rounded-full', state === 'todo' ? 'bg-line' : 'bg-primary')} aria-hidden="true" />
            <span className={cn('mt-2 flex items-center gap-1 truncate text-xs font-bold', state === 'todo' ? 'text-muted' : 'text-ink')}>
              {state === 'done' && <Check className="size-3.5 shrink-0 text-success-ink" aria-hidden="true" />}
              <span className="max-sm:hidden">{label}</span>
              <span className="sm:hidden">{i + 1}</span>
              <span className="sr-only">{state === 'current' ? '，当前步骤' : state === 'done' ? '，已完成' : '，未开始'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** @param {Record<string, any>} props */
export function Notice({ tone = 'warn', role = 'status', children, className }) {
  return (
    <div role={role} className={cn('flex items-start gap-2 rounded-tile px-3.5 py-3 text-sm font-semibold', TONES[tone], className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** @param {Record<string, any>} props */
function StepTitle({ title, sub }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-black tracking-tight lg:text-display-sm">{title}</h1>
      {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
    </div>
  );
}

/** @param {Record<string, any>} props */
export function StepCity({ cityQuery, setCityQuery, citySuggestions, commitCity, city, isTrustedCity }) {
  return (
    <section>
      <StepTitle title="想去哪座城市？" sub="杭州、上海、苏州已有真实打卡数据；其他城市也能生成，但需要出发前多核对。" />
      <Field label="目的地城市">
        <input
          id="builder-city"
          className={cn(inputClass, 'h-14 text-lg font-semibold')}
          value={cityQuery}
          list="builder-city-options"
          onChange={(event) => {
            const value = event.target.value;
            setCityQuery(value);
            if (citySuggestions.includes(value.trim())) commitCity(value);
          }}
          onBlur={() => commitCity()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitCity();
          }}
          placeholder="例如：杭州、上海、苏州，或手动输入其他城市"
        />
      </Field>
      <datalist id="builder-city-options">
        {citySuggestions.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      {/* Trusted cities as photo cards: the step's focal point, and the photos are the bundled city shots. */}
      <div className="mt-5 grid grid-cols-3 gap-2.5 sm:gap-3" role="group" aria-label="首批可信城市">
        {trustedCities.map((item) => {
          const cover = cityCover(item);
          const active = item === city;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitCity(item)}
              className={cn(
                'group relative isolate flex h-24 items-end overflow-hidden rounded-tile p-2.5 text-left text-white ring-offset-2 transition-shadow sm:h-32 sm:p-3',
                active ? 'ring-[3px] ring-ink' : 'ring-1 ring-line hover:ring-ink/40'
              )}
            >
              {cover && (
                <img
                  src={smallImage(cover)}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 -z-20 size-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transition-none"
                />
              )}
              <span className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,0)_30%,rgba(10,12,16,.72)_100%)]" aria-hidden="true" />
              {active && (
                <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-white text-ink shadow-card" aria-hidden="true">
                  <Check className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-copy font-extrabold sm:text-lead">
                  <MapPin className="size-4 shrink-0" aria-hidden="true" /> {item}
                </span>
                <span className="mt-0.5 block truncate text-xs font-semibold text-white/85 max-sm:hidden">已有真实打卡</span>
              </span>
            </button>
          );
        })}
      </div>
      {!isTrustedCity && <Notice className="mt-5">{city} 是试验生成：地点、营业信息和导航都需要出发前人工核对。</Notice>}
    </section>
  );
}

/** @param {Record<string, any>} props */
export function StepGuide(props) {
  const {
    guide,
    setGuide,
    handleScreenshotFiles,
    urlsPendingImport,
    failedImportUrls,
    importState,
    hasUrls,
    handleImportLinks,
    candidatePlaces,
    setCandidatePlaces,
    manualPlace,
    setManualPlace,
    addManualPlace,
    updateCandidate,
    ocrState
  } = props;
  const average = averageSourcePrediction(importState.sources);
  const includedCount = candidatePlaces.filter((place) => place.included).length;
  return (
    <section>
      <StepTitle title="把攻略和收藏丢进来" sub="粘贴公开链接、正文摘要、想去的地点，或上传截图。" />
      <label className="sr-only" htmlFor="builder-guide">
        攻略链接、正文摘要或收藏地点
      </label>
      <textarea
        id="builder-guide"
        className={cn(inputClass, 'min-h-36')}
        placeholder="例如：小红书 / 抖音 / X 链接、攻略正文、想去的地点。打不开的链接请顺手贴一段正文摘要。"
        value={guide}
        onChange={(e) => setGuide(e.target.value)}
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label
          htmlFor="builder-screenshots"
          className="group flex cursor-pointer items-center gap-3 rounded-card border-2 border-dashed border-line-strong bg-white p-4 transition-colors hover:border-sky focus-within:border-sky"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-sky-soft text-sky-ink">
            <ImageUp className="size-5" aria-hidden="true" />
          </span>
          <span>
            <strong className="block text-copy font-extrabold">上传截图</strong>
            <span className="text-xs text-muted">自动识别地点、价格和时间</span>
          </span>
          <input
            id="builder-screenshots"
            type="file"
            accept="image/*"
            multiple
            aria-describedby="builder-upload-privacy"
            onChange={handleScreenshotFiles}
            className="sr-only"
          />
        </label>
        <div className="flex items-center gap-3 rounded-card border border-line bg-canvas p-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-white text-muted">
            <Link className="size-5" aria-hidden="true" />
          </span>
          <span>
            <strong className="block text-copy font-extrabold">公开链接分析</strong>
            <span className="text-xs text-muted">不绕过登录墙，只读公开内容</span>
          </span>
        </div>
      </div>
      <p id="builder-upload-privacy" className="mt-2 text-xs leading-relaxed text-muted">
        隐私提示：截图会上传到当前配置的第三方模型服务做文字识别。请先裁掉姓名、手机号、订单号、证件、精确定位等敏感信息；选择文件即表示同意。
      </p>

      {(urlsPendingImport.length > 0 || failedImportUrls.length > 0 || (importState.error && hasUrls)) && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => handleImportLinks({ retryFailed: failedImportUrls.length > 0 })}
          disabled={importState.loading}
        >
          {importState.loading ? <Loader2 className="animate-spin" /> : <Link />}
          {importState.loading ? '导入中...' : failedImportUrls.length > 0 ? '重试失败的链接' : '分析新加的链接'}
        </Button>
      )}
      {importState.error && (
        <Notice role="alert" className="mt-3">
          {importState.error}
        </Notice>
      )}
      {importState.sources.length > 0 && (
        <div className="mt-4 rounded-card border border-line bg-white p-4">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {importState.sources.length} 条来源已分析，来源预测均分 {average}；该分数不代表真实到访验证
          </p>
          <div className="flex items-center justify-between gap-2">
            <strong className="text-copy font-extrabold">已分析 {importState.sources.length} 条来源</strong>
            <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', TONES[sourcePredictionTone(average)])}>预测均分 {average}</span>
          </div>
          <ul className="mt-2 divide-y divide-line">
            {importState.sources.map((s, i) => {
              const score = sourcePredictionValue(s);
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', TONES[sourcePredictionTone(score)])}>来源预测 {score ?? '待计算'}</span>
                  <span className="min-w-0 flex-1 text-ink-2">
                    {s.platform || '公开链接'} · {importStatusLabel(s.status, s.unavailableReason)} · {s.title?.slice(0, 30) || '标题待补充'}
                  </span>
                  {s.warnings?.[0] && <small className="w-full text-xs text-lemon-ink">{s.warnings[0]}</small>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-6 rounded-panel border border-line bg-white p-4 shadow-card lg:p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-extrabold">确认要去的地点</h3>
          <span className="rounded-full bg-sky-soft px-2.5 py-0.5 text-xs font-bold text-sky-ink" role="status" aria-live="polite">
            {includedCount} 个会排进路线
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <label className="sr-only" htmlFor="builder-manual-place">
            手动补充地点
          </label>
          <input
            id="builder-manual-place"
            className={inputClass}
            value={manualPlace}
            onChange={(event) => setManualPlace(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addManualPlace();
              }
            }}
            placeholder="手动加一个，例如：法喜寺、武康路"
          />
          <Button variant="dark" className="shrink-0" onClick={addManualPlace}>
            <Plus /> 添加
          </Button>
        </div>
        {candidatePlaces.length ? (
          <ul className="mt-3 grid grid-cols-1 gap-2">
            {candidatePlaces.map((place, index) => (
              <li
                key={`${place.name}-${index}`}
                className={cn('flex items-center gap-2 rounded-tile border border-line p-2.5 pl-3', place.included ? 'bg-white' : 'border-dashed bg-canvas')}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[#bd3f2a]"
                    checked={place.included}
                    onChange={(event) => updateCandidate(index, { included: event.target.checked })}
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-copy font-bold">{place.name}</strong>
                    <span
                      className="block truncate text-xs text-muted"
                      // The raw 0–100 number read like a grade; the reason already says how sure we are.
                      title={place.confidence != null ? `识别把握 ${place.confidence}/100` : undefined}
                    >
                      {place.source || '候选来源'}
                      {place.reason ? ` · ${place.reason}` : ''}
                      {place.note ? ` · ${place.note}` : ''}
                    </span>
                  </span>
                </label>
                <button
                  type="button"
                  aria-pressed={Boolean(place.mustGo)}
                  onClick={() => updateCandidate(index, { mustGo: !place.mustGo, included: true })}
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-bold transition-colors',
                    place.mustGo ? 'bg-primary-strong text-white' : 'border border-line-strong bg-white text-ink-2 hover:border-ink/40'
                  )}
                >
                  {place.mustGo ? <Check className="size-3.5" aria-hidden="true" /> : <MapPin className="size-3.5" aria-hidden="true" />} 必去
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCandidatePlaces((prev) => prev.filter((_, currentIndex) => currentIndex !== index))}
                  aria-label={`删除${place.name}`}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">输入攻略、导入链接、上传截图或手动添加后，识别出的地点会列在这里；默认都不勾选，勾选的才会排进路线。</p>
        )}
      </div>

      {(ocrState.loading || ocrState.places.length > 0 || ocrState.warnings.length > 0) && (
        <div className="mt-4 rounded-card border border-line bg-white p-4" role="status" aria-live="polite" aria-atomic="true">
          <p className="flex items-center gap-2 text-sm font-bold">
            {ocrState.loading && <Loader2 className="size-4 animate-spin text-sky-ink" aria-hidden="true" />}
            {ocrState.loading ? '正在识别截图里的地点、时间和价格...' : `截图识别完成：${ocrState.places.length} 个候选地点`}
          </p>
          <ul className="mt-2 grid gap-1.5">
            {ocrState.places.slice(0, 6).map((place, i) => (
              <li key={`${place.name}-${i}`} className="flex items-center gap-2 text-sm text-ink-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', TONES.warn)}>待核对</span>
                {place.name} · {place.time || '时间待核对'} · {place.price || '价格待核对'}
              </li>
            ))}
          </ul>
          {ocrState.warnings.map((warning, i) => (
            <p key={i} className="mt-1.5 text-sm font-semibold text-lemon-ink">
              {warning}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** @param {Record<string, any>} props */
function ToggleChips({ legend, icon: Icon, options, isActive, onToggle }) {
  return (
    <fieldset>
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-bold text-ink-2">
        {Icon && <Icon className="size-4 text-muted" aria-hidden="true" />}
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = isActive(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option)}
              className={cn(
                'inline-flex h-10 items-center gap-1 rounded-full border px-4 text-sm font-bold transition-colors',
                active ? 'border-ink bg-ink text-white' : 'border-line-strong bg-white text-ink hover:border-ink/40'
              )}
            >
              {active && <Check className="size-3.5" aria-hidden="true" />}
              {option}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** @param {Record<string, any>} props */
export function StepPrefs({ constraints, setConstraints, toggleTheme, options, mode = 'fast', setMode = () => {}, generation = null }) {
  const pick = (key) => ({ isActive: (v) => constraints[key] === v, onToggle: (v) => setConstraints((p) => ({ ...p, [key]: v })) });
  return (
    <section>
      <StepTitle title="你想怎么玩？" sub="选好这些，AI 按它排路线；之后都能改。" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="出行日期" hint="可选。日期控件可能显示为英文格式。">
          <span className="relative">
            <CalendarDays className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              id="builder-date"
              className={cn(inputClass, 'pl-9')}
              type="date"
              value={constraints.date}
              onChange={(e) => setConstraints((p) => ({ ...p, date: e.target.value }))}
            />
          </span>
        </Field>
        <Field label="住宿 / 出发地">
          <span className="relative">
            <Home className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              id="builder-base"
              className={cn(inputClass, 'pl-9')}
              value={constraints.base}
              onChange={(e) => setConstraints((p) => ({ ...p, base: e.target.value }))}
              placeholder="湖滨银泰、杭州东站..."
            />
          </span>
        </Field>
      </div>
      <div className="mt-6 grid gap-5">
        <ToggleChips legend="玩几天" options={options.durations} {...pick('duration')} />
        <div>
          <ToggleChips
            legend="预算（每人）"
            options={options.budgets}
            isActive={(label) => budgetValueForLabel(label) === (constraints.budget ?? '')}
            onToggle={(label) => setConstraints((p) => ({ ...p, budget: budgetValueForLabel(label) }))}
          />
          <p className="mt-1.5 text-meta text-muted">{budgetHint(constraints.budget)}</p>
        </div>
        <ToggleChips legend="节奏" options={options.tempos} {...pick('tempo')} />
        <ToggleChips legend="和谁一起" options={options.companions} {...pick('companion')} />
        <ToggleChips legend="交通偏好" icon={Train} options={options.transports} {...pick('transport')} />
        <ToggleChips legend="主题（可多选）" options={options.themes} isActive={(v) => constraints.theme.includes(v)} onToggle={toggleTheme} />
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="必去地点">
          <input
            id="builder-must-go"
            className={inputClass}
            value={constraints.mustGo}
            onChange={(e) => setConstraints((p) => ({ ...p, mustGo: e.target.value }))}
            placeholder="西湖、法喜寺"
          />
        </Field>
        <Field label="想避开">
          <input
            id="builder-avoid"
            className={inputClass}
            value={constraints.avoid}
            onChange={(e) => setConstraints((p) => ({ ...p, avoid: e.target.value }))}
            placeholder="排队过久、商业街同质化"
          />
        </Field>
      </div>
      <GenerationModePicker mode={mode} setMode={setMode} generation={generation} />
    </section>
  );
}

export function GenerationModePicker({ mode, setMode, generation = null }) {
  const remaining = generation && typeof generation.remaining === 'number' ? generation.remaining : null;
  const windowHours = generation?.windowHours || 24;
  return (
    <fieldset className="mt-6">
      <legend className="text-copy font-bold text-ink">生成方式</legend>
      {generation && remaining != null && (
        <p className={cn('mt-1.5 text-sm', generation.limited ? 'font-semibold text-danger' : 'text-muted')} role="status">
          {generation.limited
            ? `本周期生成次数已用完（每 ${windowHours} 小时 ${generation.quota} 次），请稍后再试`
            : `本周期还可生成 ${remaining} 次（共 ${generation.quota} 次 / ${windowHours} 小时）`}
        </p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {GENERATION_MODES.map((item) => {
          const active = mode === item.key;
          return (
            <label
              key={item.key}
              className={cn(
                'flex cursor-pointer gap-3 rounded-card border p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary',
                active ? 'border-primary bg-primary-soft/60' : 'border-line bg-white hover:border-ink-2/40',
                generation?.limited && 'opacity-60'
              )}
            >
              <input
                type="radio"
                name="generation-mode"
                value={item.key}
                checked={active}
                disabled={Boolean(generation?.limited)}
                onChange={() => setMode(item.key)}
                className="mt-1 size-4 accent-[var(--color-primary,#e8553d)]"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-copy font-black text-ink">{item.label}</span>
                  <span className="text-sm font-semibold text-ink-2">{item.time}</span>
                </span>
                <span className="mt-0.5 block text-sm text-ink-2">{item.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** @param {Record<string, any>} props */

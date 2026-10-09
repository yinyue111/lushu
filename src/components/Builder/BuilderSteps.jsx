import { AlertCircle, ArrowLeft, CalendarDays, Check, Home, ImageUp, Link, Loader2, MapPin, Plus, Sparkles, Train, X } from 'lucide-react';
import { trustedCities } from '../../lib/content';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { cn } from '../ui/cn';
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
      <h2 className="text-2xl font-black tracking-tight lg:text-display-sm">{title}</h2>
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
      <div className="mt-4 flex flex-wrap gap-2" aria-label="首批可信城市">
        {trustedCities.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === city}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitCity(item)}
            className={cn(
              'inline-flex h-11 items-center gap-1.5 rounded-full border px-5 text-copy font-bold transition-colors',
              item === city ? 'border-ink bg-ink text-white' : 'border-line-strong bg-white text-ink hover:border-ink/40'
            )}
          >
            <MapPin className="size-4" aria-hidden="true" /> {item}
          </button>
        ))}
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
                    {s.platform || '公开链接'} · {importStatusLabel(s.status)} · {s.title?.slice(0, 30) || '标题待补充'}
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
                className={cn('flex items-center gap-2 rounded-tile border border-line p-2.5 pl-3', place.included ? 'bg-white' : 'bg-canvas opacity-70')}
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
                    <span className="block truncate text-xs text-muted">
                      {place.source || '候选来源'}
                      {place.reason ? ` · ${place.reason}` : ''}
                      {place.confidence != null ? `（把握 ${place.confidence}）` : ''}
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
export function StepPrefs({ constraints, setConstraints, toggleTheme, options }) {
  const pick = (key) => ({ isActive: (v) => constraints[key] === v, onToggle: (v) => setConstraints((p) => ({ ...p, [key]: v })) });
  return (
    <section>
      <StepTitle title="你想怎么玩？" sub="选好约束，AI 会据此排路线；都可以之后再改。" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="出行日期">
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
    </section>
  );
}

/** @param {Record<string, any>} props */
export function StepGenerate({ error, loading, city, duration, genSteps, onRetry, onBackToPrefs }) {
  return (
    <section className="mx-auto max-w-md pt-6 text-center">
      <div
        className={cn(
          'mx-auto grid size-20 place-items-center rounded-full',
          error ? 'bg-primary-soft text-primary-strong' : 'bg-[linear-gradient(135deg,#e8553d,#ffc93c)] text-white shadow-cta',
          loading && !error && 'animate-pulse'
        )}
      >
        {error ? <AlertCircle className="size-9" aria-hidden="true" /> : <Sparkles className="size-9" aria-hidden="true" />}
      </div>
      <h2 className="mt-5 text-2xl font-black tracking-tight">{error ? '这次没能生成路书' : loading ? '正在生成路书' : '路书生成完成'}</h2>
      <p className="mt-1 text-sm text-muted">
        {city} · {duration}
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {genSteps.length ? `生成进度：${genSteps.at(-1)}` : '正在准备生成'}
      </p>
      <ol className="mx-auto mt-6 grid max-w-xs gap-2.5 text-left" aria-label="路书生成进度">
        {genSteps.map((s, i) => (
          <li key={i} className="flex items-center gap-2.5 text-copy">
            {i === genSteps.length - 1 && loading ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
            ) : (
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success text-white">
                <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              </span>
            )}
            <span className="text-ink-2">{s}</span>
          </li>
        ))}
      </ol>
      {error && (
        <div role="alert" className="mt-6 rounded-card border border-primary/30 bg-primary-soft p-4 text-left">
          <p className="flex items-start gap-2 text-sm font-semibold text-primary-strong">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {error}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={onRetry}>
              <Sparkles /> 再试一次
            </Button>
            <Button variant="outline" size="sm" onClick={onBackToPrefs}>
              <ArrowLeft /> 改改偏好
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

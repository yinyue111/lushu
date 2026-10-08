import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { analyzeGuideImages, generateRoutebook, getApiToken, getCities, importGuide, saveProfile, setApiToken } from '../../lib/api';
import { trustedCities } from '../../lib/content';
import { createRouteEditToken, getProfile, profileRoutebookFields, updateProfile } from '../../lib/profile';
import { adoptServerProfile } from '../../lib/profileSync';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { Notice, StepCity, StepGenerate, StepGuide, StepPrefs, Stepper } from './BuilderSteps';
import { sourcePredictionValue } from './builderModel';

const defaultConstraints = {
  duration: '2 天 1 晚',
  budget: '人均 900',
  tempo: '松弛但不空',
  companion: '朋友',
  date: '',
  base: '',
  transport: '步行 + 打车',
  theme: ['Citywalk'],
  mustGo: '',
  avoid: ''
};
const durations = ['1 日', '2 天 1 晚', '3 天 2 晚'];
const budgets = ['人均 500', '人均 900', '人均 1500'];
const tempos = ['少走路', '松弛但不空', '高密度打卡'];
const companions = ['独行', '情侣', '朋友', '亲子'];
const transports = ['步行 + 打车', '地铁优先', '少换乘', '亲子少走路'];
const themes = ['Citywalk', '美食拍照', '寺院茶山', '展览咖啡', '园林夜游', '亲子慢游'];
const builderStepLabels = ['选择目的地', '导入攻略与收藏', '设置旅行偏好', '生成路书'];
const BUILDER_DRAFT_PREFIX = 'trusted-routebook:builder-draft:v1';
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

/** @param {{ modelHealth?: any, defaults?: Record<string, any>, onGenerated?: Function, onProfileChanged?: Function, onBack?: Function }} props */
/** @param {Record<string, any>} props */
export default function BuilderFlow({ modelHealth, defaults = {}, onGenerated, onProfileChanged, onBack }) {
  const [profile, setProfile] = useState(() => getProfile());
  const [initialDraft] = useState(() => (hasBuilderDefaults(defaults) ? null : readBuilderDraft(profile.id)));
  const [apiTokenInput, setApiTokenInput] = useState(() => getApiToken());
  const [step, setStep] = useState(() => Math.min(2, Math.max(0, Number(defaults.initialStep ?? initialDraft?.step) || 0)));
  const initialConstraints = useMemo(
    () => ({
      ...defaultConstraints,
      ...(initialDraft?.constraints ?? {}),
      duration: defaults.duration ?? initialDraft?.constraints?.duration ?? defaultConstraints.duration,
      budget: defaults.budget ?? initialDraft?.constraints?.budget ?? profile.budget ?? defaultConstraints.budget,
      tempo: defaults.tempo ?? initialDraft?.constraints?.tempo ?? profile.tempo ?? defaultConstraints.tempo,
      companion: defaults.companion ?? initialDraft?.constraints?.companion ?? profile.companion ?? defaultConstraints.companion,
      transport: defaults.transport ?? initialDraft?.constraints?.transport ?? profile.transport ?? defaultConstraints.transport,
      theme:
        Array.isArray(defaults.theme) && defaults.theme.length
          ? defaults.theme
          : initialDraft?.constraints?.theme?.length
            ? initialDraft.constraints.theme
            : profile.themes?.length
              ? profile.themes.slice(0, 4)
              : defaultConstraints.theme
    }),
    [defaults.duration, defaults.theme, defaults.budget, defaults.tempo, defaults.companion, defaults.transport, initialDraft, profile]
  );
  const initialCity = defaults.city ?? initialDraft?.city ?? profile.preferredCities?.[0] ?? profile.homeCity ?? '杭州';
  const [city, setCity] = useState(initialCity);
  const [cityQuery, setCityQuery] = useState(initialDraft?.cityQuery ?? initialCity);
  const [citySuggestions, setCitySuggestions] = useState([]);
  const [guide, setGuide] = useState(defaults.guide ?? initialDraft?.guide ?? '');
  const [constraints, setConstraints] = useState(initialConstraints);
  const [screenshotNotes, setScreenshotNotes] = useState(initialDraft?.screenshotNotes ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [genSteps, setGenSteps] = useState([]);
  const [importState, setImportState] = useState({ loading: false, sources: initialDraft?.importedSources ?? [], error: '' });
  const [ocrState, setOcrState] = useState({ loading: false, places: initialDraft?.ocrPlaces ?? [], warnings: initialDraft?.ocrWarnings ?? [] });
  const [candidatePlaces, setCandidatePlaces] = useState(initialDraft?.candidatePlaces ?? []);
  const [manualPlace, setManualPlace] = useState(initialDraft?.manualPlace ?? '');
  const mountedRef = useRef(true);
  const generationSequence = useRef(0);
  const generationAbort = useRef(null);
  const generationInterval = useRef(null);
  const generationTimeout = useRef(null);
  const importAbort = useRef(null);
  const importPromise = useRef(null);
  const autoImportStarted = useRef(false);
  const ocrAbort = useRef(null);

  useEffect(() => {
    writeBuilderDraft(profile.id, {
      step: Math.min(step, 2),
      city,
      cityQuery,
      guide,
      constraints,
      screenshotNotes,
      importedSources: importState.sources,
      ocrPlaces: ocrState.places,
      ocrWarnings: ocrState.warnings,
      candidatePlaces,
      manualPlace
    });
  }, [
    candidatePlaces,
    city,
    cityQuery,
    constraints,
    guide,
    importState.sources,
    manualPlace,
    ocrState.places,
    ocrState.warnings,
    profile.id,
    screenshotNotes,
    step
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelGeneration();
      importAbort.current?.abort();
      ocrAbort.current?.abort();
    };
  }, []);

  // 占位/取消状态的截图备注（正在 OCR 识别 / 已取消）只用于界面提示，
  // 不进入生成 prompt，避免中断批次把无效状态泄漏给模型。
  const promptScreenshotNotes = screenshotNotes.filter((note) => {
    const text = String(note ?? '');
    return !text.endsWith('（正在 OCR 识别）') && !text.endsWith('（已取消）');
  });
  const fullGuide = [
    guide,
    candidatePlaces.length ? buildCandidateGuide(candidatePlaces) : '',
    promptScreenshotNotes.length ? `截图/收藏补充：${promptScreenshotNotes.join('；')}` : '',
    constraints.date ? `出行日期：${constraints.date}` : '',
    constraints.base ? `住宿/出发地：${constraints.base}` : '',
    constraints.transport ? `交通偏好：${constraints.transport}` : '',
    constraints.theme?.length ? `主题偏好：${constraints.theme.join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const hasGuideInput = guide.trim().length > 0 || candidatePlaces.length > 0 || ocrState.places.length > 0;
  const canProceed = step === 0 ? Boolean(cityQuery.trim()) : step === 1 ? hasGuideInput : step === 2;
  const urlsPendingImport = useMemo(() => findUnimportedUrls(guide, importState.sources), [guide, importState.sources]);
  const failedImportUrls = useMemo(() => findFailedImportUrls(guide, importState.sources), [guide, importState.sources]);

  useEffect(() => {
    if (step !== 0) return undefined;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      getCities(cityQuery.trim(), ctrl.signal)
        .then((data) => {
          if (!mountedRef.current || ctrl.signal.aborted) return;
          setCitySuggestions(Array.isArray(data.cities) ? data.cities.slice(0, 12) : []);
        })
        .catch(() => {
          // 联想接口失败时静默降级为无联想。
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [cityQuery, step]);

  useEffect(() => {
    if (step !== 1 || !defaults.autoImport || autoImportStarted.current || !urlsPendingImport.length) return undefined;
    const timer = window.setTimeout(() => {
      autoImportStarted.current = true;
      void handleImportLinks({ silentWhenComplete: true });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auto-import must fire once per step change, not whenever the URL list or handler identity changes.
  }, [defaults.autoImport, step]);

  async function handleImportLinks({ retryFailed = false, silentWhenComplete = false } = {}) {
    if (importPromise.current) return importPromise.current;
    const uniqueUrls = [
      ...new Set([...findUnimportedUrls(guide, importState.sources), ...(retryFailed ? findFailedImportUrls(guide, importState.sources) : [])])
    ];
    if (!uniqueUrls.length) {
      if (!silentWhenComplete) setImportState((prev) => ({ ...prev, error: '' }));
      return true;
    }
    importAbort.current?.abort();
    const ctrl = new AbortController();
    importAbort.current = ctrl;
    setImportState((prev) => ({ ...prev, loading: true, error: '' }));
    const task = importGuide(uniqueUrls, ctrl.signal)
      .then((data) => {
        if (!mountedRef.current || ctrl.signal.aborted) return false;
        setImportState((prev) => ({ loading: false, sources: mergeImportedSources(prev.sources, data.sources ?? []), error: '' }));
        if (data.guideText) setGuide((prev) => (prev.includes(data.guideText) ? prev : [prev.trim(), data.guideText].filter(Boolean).join('\n\n')));
        addCandidatePlaces(extractCandidatePlacesFromSources(data.sources ?? []));
        return true;
      })
      .catch((e) => {
        if (!mountedRef.current || ctrl.signal.aborted) return false;
        setImportState((prev) => ({ ...prev, loading: false, error: e.message }));
        setError(e.message);
        return false;
      })
      .finally(() => {
        if (importPromise.current === task) importPromise.current = null;
      });
    importPromise.current = task;
    return task;
  }

  async function handleGenerate() {
    cancelGeneration();
    const generationId = generationSequence.current;
    const ctrl = new AbortController();
    generationAbort.current = ctrl;
    setLoading(true);
    setError('');
    setGenSteps(['识别平台链接与用户偏好']);
    const steps = ['提取 POI 与收藏地点', '按可信来源降权/加权', '检查时间、预算与步行强度', '编排分日地图动线', '生成可信分与行中提示'];
    let i = 0;
    generationInterval.current = setInterval(() => {
      if (mountedRef.current && generationSequence.current === generationId && i < steps.length) {
        setGenSteps((prev) => [...prev, steps[i]]);
        i++;
      }
    }, 2500);

    try {
      if (apiTokenInput.trim()) setApiToken(apiTokenInput);
      const localProfile = updateProfile({
        ...profile,
        preferredCities: [city, ...(profile.preferredCities ?? []).filter((item) => item !== city)],
        budget: constraints.budget,
        companion: constraints.companion,
        tempo: constraints.tempo,
        transport: constraints.transport,
        themes: constraints.theme
      });
      setProfile(localProfile);
      let activeProfile = localProfile;
      try {
        const profileData = await saveProfile(localProfile, ctrl.signal);
        if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
        activeProfile = adoptServerProfile(profileData.profile, localProfile).profile;
        setProfile(activeProfile);
        onProfileChanged?.(activeProfile);
      } catch {
        if (ctrl.signal.aborted || generationSequence.current !== generationId) return;
        activeProfile = localProfile;
      }
      const data = await generateRoutebook(
        {
          city,
          guide: fullGuide,
          profileId: activeProfile.id,
          editToken: createRouteEditToken(),
          constraints: {
            ...constraints,
            theme: constraints.theme?.join('、')
          },
          importedSources: importState.sources
        },
        ctrl.signal
      );
      if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
      clearInterval(generationInterval.current);
      generationInterval.current = null;
      setGenSteps((prev) => [...prev, '完成']);
      generationTimeout.current = setTimeout(() => {
        if (mountedRef.current && generationSequence.current === generationId) {
          clearBuilderDraft(activeProfile.id);
          onGenerated({ ...data, ...profileRoutebookFields(activeProfile) });
        }
      }, 600);
    } catch (e) {
      clearInterval(generationInterval.current);
      generationInterval.current = null;
      if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
      setLoading(false);
      setError(e.status === 403 ? `${e.message}。如果是远程部署，请填写平台访问码后重试。` : e.message);
    }
  }

  function retryGenerate() {
    if (loading) return;
    handleGenerate();
  }

  function cancelGeneration() {
    generationSequence.current += 1;
    generationAbort.current?.abort();
    generationAbort.current = null;
    clearInterval(generationInterval.current);
    generationInterval.current = null;
    clearTimeout(generationTimeout.current);
    generationTimeout.current = null;
  }

  function leaveBuilder() {
    cancelGeneration();
    onBack();
  }

  async function next() {
    if (step === 0) {
      // 城市为空或被清空时留在本步，属预期校验拦截。
      if (!commitCity()) return;
      setStep(1);
      return;
    }
    if (step === 1) {
      if (urlsPendingImport.length) {
        const imported = await handleImportLinks({ silentWhenComplete: true });
        if (!imported || !mountedRef.current) return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setStep(3);
      handleGenerate();
    } else setStep((s) => s + 1);
  }

  const hasUrls = /https?:\/\/[^\s"'<>，。；、)）]+/i.test(guide);
  const isTrustedCity = trustedCities.includes(city);

  function commitCity(nextCity = cityQuery) {
    const normalized = String(nextCity ?? '')
      .trim()
      .replace(/市$/, '');
    if (!normalized) {
      // 输入被清空时同步清掉已提交城市，避免带旧城市进入下一步。
      setCity('');
      setCityQuery('');
      return '';
    }
    setCity(normalized);
    setCityQuery(normalized);
    return normalized;
  }

  function toggleTheme(item) {
    setConstraints((prev) => {
      const next = prev.theme.includes(item) ? prev.theme.filter((theme) => theme !== item) : [...prev.theme, item].slice(0, 4);
      return { ...prev, theme: next.length ? next : [item] };
    });
  }

  async function handleScreenshotFiles(event) {
    const files = Array.from(event.target.files ?? []).slice(0, 4);
    event.target.value = '';
    if (!files.length) return;
    const oversizedFiles = files.filter((file) => file.size > MAX_SCREENSHOT_BYTES);
    if (oversizedFiles.length) {
      const names = oversizedFiles.map((file) => file.name).join('、');
      const message = `截图 ${names} 超过单张 2 MB，请压缩或裁剪后重试`;
      setOcrState({ loading: false, places: [], warnings: [message] });
      setError(message);
      return;
    }
    const notes = files.map((file) => `${file.name}（正在 OCR 识别）`);
    const finishNotes = (status) => {
      const replacements = new Map(files.map((file) => [`${file.name}（正在 OCR 识别）`, `${file.name}（${status}）`]));
      setScreenshotNotes((prev) => prev.map((note) => replacements.get(note) ?? note));
    };
    setScreenshotNotes((prev) => [...prev, ...notes].slice(-8));
    setOcrState({ loading: true, places: [], warnings: [] });
    ocrAbort.current?.abort();
    const ctrl = new AbortController();
    ocrAbort.current = ctrl;
    try {
      const images = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type || 'image/png',
          data: await readFileAsDataUrl(file)
        }))
      );
      const data = await analyzeGuideImages(images, ctrl.signal);
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setOcrState({ loading: false, places: data.places ?? [], warnings: data.warnings ?? [] });
      finishNotes(`OCR 已识别 ${data.places?.length ?? 0} 个地点`);
      addCandidatePlaces(
        (data.places ?? []).map((place) => ({
          name: place.name,
          source: '截图 OCR',
          confidence: place.confidence,
          note: [place.time, place.price, place.note].filter(Boolean).join(' · '),
          included: true,
          mustGo: false
        }))
      );
      const lines = [
        `截图 OCR 识别：${files.map((file) => file.name).join('、')}`,
        data.guideText,
        ...(data.places ?? []).map(
          (place, index) =>
            `${index + 1}. ${place.name}${place.time ? `｜${place.time}` : ''}${place.price ? `｜${place.price}` : ''}${place.note ? `｜${place.note}` : ''}`
        )
      ].filter(Boolean);
      setGuide((prev) => `${prev}${prev ? '\n\n' : ''}${lines.join('\n')}`);
    } catch (e) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setOcrState({ loading: false, places: [], warnings: [e.message] });
      finishNotes('OCR 识别失败，待手动复核');
      setGuide(
        (prev) =>
          `${prev}${prev ? '\n' : ''}已上传截图：${files.map((file) => file.name).join('、')}。截图暂未识别成功，请结合文件名线索和手动补充正文生成路线，未识别内容需标记为待复核。`
      );
    } finally {
      // 批次被中断（切换新批次或离开页面）时统一收尾占位备注，
      // 避免「正在 OCR 识别」永久残留在截图备注里。
      if (ctrl.signal.aborted) finishNotes('已取消');
    }
  }

  function addCandidatePlaces(places) {
    setCandidatePlaces((prev) => {
      const map = new Map(prev.map((place) => [normalizePlaceKey(place.name), place]));
      for (const place of places) {
        const key = normalizePlaceKey(place.name);
        if (!key) continue;
        const existing = map.get(key);
        map.set(key, {
          name: place.name,
          source: place.source || '手动补充',
          confidence: Number(place.confidence ?? 62),
          note: place.note || existing?.note || '',
          included: place.included ?? existing?.included ?? true,
          mustGo: place.mustGo ?? existing?.mustGo ?? false
        });
      }
      return [...map.values()].slice(0, 24);
    });
  }

  function addManualPlace() {
    const name = manualPlace.trim();
    if (!name) return;
    addCandidatePlaces([{ name, source: '手动补充', confidence: 90, included: true, mustGo: true }]);
    setManualPlace('');
  }

  function updateCandidate(index, patch) {
    setCandidatePlaces((prev) => prev.map((place, currentIndex) => (currentIndex === index ? { ...place, ...patch } : place)));
  }

  const nextDisabled = !canProceed || importState.loading || ocrState.loading || (!modelHealth?.ready && step === 2);

  return (
    <div className="page-enter mx-auto max-w-[760px] px-4 pt-5 pb-32 lg:pt-8">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={leaveBuilder}>
          <ArrowLeft /> 返回
        </Button>
        <details className="group relative text-sm">
          <summary className="cursor-pointer list-none rounded-full px-3 py-1.5 font-semibold text-muted hover:bg-canvas">高级设置</summary>
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-card border border-line bg-white p-4 shadow-pop">
            <Field label="平台访问码" hint="远程部署启用模型代理时填写">
              <input
                id="builder-api-token"
                className={inputClass}
                type="password"
                value={apiTokenInput}
                onChange={(event) => setApiTokenInput(event.target.value)}
                onBlur={() => setApiToken(apiTokenInput)}
                placeholder="远程部署启用模型代理时填写"
              />
            </Field>
          </div>
        </details>
      </div>

      <header className="mt-3">
        <span className="text-xs font-extrabold tracking-[0.08em] text-primary-strong">
          创建我的路书 · 第 {step + 1} 步，共 {builderStepLabels.length} 步
        </span>
        <div className="mt-3">
          <Stepper labels={builderStepLabels} step={step} />
        </div>
      </header>

      {!isTrustedCity && step > 0 && <Notice className="mt-5">{city} 是试验生成：地点、营业信息和导航都需要出发前人工核对。</Notice>}

      <div className="mt-8">
        {step === 0 && (
          <StepCity
            cityQuery={cityQuery}
            setCityQuery={setCityQuery}
            citySuggestions={citySuggestions}
            commitCity={commitCity}
            city={city}
            isTrustedCity={isTrustedCity}
          />
        )}
        {step === 1 && (
          <StepGuide
            guide={guide}
            setGuide={setGuide}
            handleScreenshotFiles={handleScreenshotFiles}
            urlsPendingImport={urlsPendingImport}
            failedImportUrls={failedImportUrls}
            importState={importState}
            hasUrls={hasUrls}
            handleImportLinks={handleImportLinks}
            candidatePlaces={candidatePlaces}
            setCandidatePlaces={setCandidatePlaces}
            manualPlace={manualPlace}
            setManualPlace={setManualPlace}
            addManualPlace={addManualPlace}
            updateCandidate={updateCandidate}
            ocrState={ocrState}
          />
        )}
        {step === 2 && (
          <StepPrefs
            constraints={constraints}
            setConstraints={setConstraints}
            toggleTheme={toggleTheme}
            options={{ durations, budgets, tempos, companions, transports, themes }}
          />
        )}
        {step === 3 && (
          <StepGenerate
            error={error}
            loading={loading}
            city={city}
            duration={constraints.duration}
            genSteps={genSteps}
            onRetry={retryGenerate}
            onBackToPrefs={() => setStep(2)}
          />
        )}
      </div>

      {step === 2 && !modelHealth?.ready && (
        <Notice role="alert" className="mt-6">
          模型暂未就绪：{modelHealth?.reason || '请确认模型服务的 base URL 和 API key 可用'}。表单内容会保留，模型恢复后可以直接生成。
        </Notice>
      )}

      {step < 3 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur max-md:bottom-[calc(56px+env(safe-area-inset-bottom))] max-md:pb-0">
          <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-4 py-3">
            <Button variant="outline" onClick={() => (step > 0 ? setStep((s) => s - 1) : leaveBuilder())}>
              <ArrowLeft /> {step === 0 ? '取消' : '上一步'}
            </Button>
            <Button variant="primary" className="min-w-36" onClick={next} disabled={nextDisabled}>
              {ocrState.loading ? (
                <>
                  <Loader2 className="animate-spin" /> 截图识别中...
                </>
              ) : step === 2 ? (
                <>
                  <Sparkles /> 生成路书
                </>
              ) : (
                <>
                  下一步 <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function hasBuilderDefaults(defaults) {
  return Boolean(defaults && Object.values(defaults).some((value) => (Array.isArray(value) ? value.length : String(value ?? '').trim())));
}

function readBuilderDraft(profileId) {
  try {
    const draft = JSON.parse(localStorage.getItem(builderDraftKey(profileId)) ?? 'null');
    return draft && typeof draft === 'object' ? draft : null;
  } catch {
    return null;
  }
}

function writeBuilderDraft(profileId, draft) {
  try {
    localStorage.setItem(builderDraftKey(profileId), JSON.stringify({ ...draft, profileId, updatedAt: new Date().toISOString() }));
  } catch {
    // Draft persistence is best-effort when storage is unavailable.
  }
}

function clearBuilderDraft(profileId) {
  try {
    localStorage.removeItem(builderDraftKey(profileId));
  } catch {
    // Draft persistence is best-effort when storage is unavailable.
  }
}

function builderDraftKey(profileId) {
  return `${BUILDER_DRAFT_PREFIX}:${encodeURIComponent(String(profileId || 'anonymous'))}`;
}

function buildCandidateGuide(candidatePlaces) {
  const included = candidatePlaces.filter((place) => place.included);
  const excluded = candidatePlaces.filter((place) => !place.included);
  if (!included.length && !excluded.length) return '';
  return [
    included.length
      ? `用户确认进入路线的候选 POI：${included.map((place) => `${place.mustGo ? '必去-' : ''}${place.name}（${place.source || '候选来源'}，来源参考分 ${place.confidence ?? '待计算'}${place.note ? `，${place.note}` : ''}）`).join('；')}`
      : '',
    excluded.length ? `用户已排除的 POI：${excluded.map((place) => place.name).join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function extractCandidatePlacesFromSources(sources) {
  const rows = [];
  for (const source of sources) {
    const text = `${source.title ?? ''} ${source.description ?? ''} ${source.excerpt ?? ''}`;
    const candidates = [
      ...Array.from(
        text.matchAll(
          /[「“]?([\u4e00-\u9fa5A-Za-z0-9·]{2,18}(?:路|街|巷|寺|园|馆|湖|山|塔|桥|镇|古城|景区|公园|广场|商场|市场|码头|茶园|博物馆|美术馆|咖啡|夜市))[」”]?/g
        )
      ).map((match) => match[1]),
      ...Array.from(text.matchAll(/(?:POI|地点|路线|打卡|必去|推荐)[:：\s]*([\u4e00-\u9fa5A-Za-z0-9·]{2,18})/gi)).map((match) => match[1])
    ];
    for (const name of candidates) {
      const cleaned = cleanPlaceName(name);
      if (!cleaned) continue;
      rows.push({
        name: cleaned,
        source: source.platform || '导入来源',
        confidence: sourcePredictionValue(source) ?? 55,
        note: source.warnings?.[0] || source.status || '',
        included: (sourcePredictionValue(source) ?? 50) >= 35,
        mustGo: false
      });
    }
  }
  return rows.slice(0, 18);
}

function extractGuideUrls(value) {
  return [...new Set(String(value ?? '').match(/https?:\/\/[^\s"'<>，。；、)）]+/gi) ?? [])];
}

function sourceUrlKeys(source) {
  return [source?.url, source?.finalUrl].map(normalizeUrlForImport).filter(Boolean);
}

function findUnimportedUrls(guide, sources = []) {
  const imported = new Set(sources.flatMap(sourceUrlKeys));
  return extractGuideUrls(guide).filter((url) => !imported.has(normalizeUrlForImport(url)));
}

function findFailedImportUrls(guide, sources = []) {
  const failed = new Set(sources.filter((source) => source?.status === 'failed').flatMap(sourceUrlKeys));
  return extractGuideUrls(guide).filter((url) => failed.has(normalizeUrlForImport(url)));
}

function normalizeUrlForImport(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    url.hash = '';
    return url.toString();
  } catch {
    return String(value ?? '').trim();
  }
}

function mergeImportedSources(existing = [], incoming = []) {
  const map = new Map();
  for (const source of [...existing, ...incoming]) {
    const key = normalizeUrlForImport(source?.url) || `${source?.platform ?? ''}:${source?.title ?? ''}`;
    if (key) map.set(key, source);
  }
  return [...map.values()];
}

function cleanPlaceName(value) {
  const text = String(value ?? '')
    .replace(/[，。；、,.!?！？【】[\]()（）]/g, '')
    .trim();
  if (text.length < 2 || text.length > 18) return '';
  if (/^(这个|那个|今天|明天|我们|他们|攻略|路线|推荐|打卡)$/.test(text)) return '';
  return text;
}

function normalizePlaceKey(value) {
  return cleanPlaceName(value).toLocaleLowerCase('zh-CN');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('截图读取失败'));
    reader.readAsDataURL(file);
  });
}

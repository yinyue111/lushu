import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, MapPin, Sparkles, Loader2, Check, Link, AlertCircle, CalendarDays, Home, ImageUp, Train, Plus, X } from 'lucide-react';
import { analyzeGuideImages, generateRoutebook, getApiToken, getCities, importGuide, saveProfile, setApiToken } from '../../lib/api';
import { trustedCities } from '../../lib/content';
import { createRouteEditToken, getProfile, profileRoutebookFields, updateProfile } from '../../lib/profile';
import { adoptServerProfile } from '../../lib/profileSync';

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

  return (
    <div className="container page-enter builder-shell">
      {/* Back button */}
      <button className="btn btn-ghost btn-sm" onClick={leaveBuilder} style={{ marginBottom: 24 }}>
        <ArrowLeft size={16} /> 返回
      </button>
      <header className="builder-heading">
        <h1 className="text-title">创建我的路书</h1>
        <p className="text-caption">
          第 {step + 1} 步，共 {builderStepLabels.length} 步
        </p>
      </header>
      <details className="builder-access">
        <summary>高级设置</summary>
        <label htmlFor="builder-api-token">
          <span className="input-label">平台访问码</span>
          <input
            id="builder-api-token"
            className="input-field"
            type="password"
            value={apiTokenInput}
            onChange={(event) => setApiTokenInput(event.target.value)}
            onBlur={() => setApiToken(apiTokenInput)}
            placeholder="远程部署启用模型代理时填写"
          />
        </label>
      </details>

      {/* Step indicator */}
      <div className="steps" role="list" aria-label="创建路书进度" style={{ marginBottom: 40 }}>
        {[0, 1, 2, 3].map((i) => (
          <React.Fragment key={i}>
            <div className="step-item" role="listitem" aria-current={i === step ? 'step' : undefined}>
              <span className={`step-dot ${i === step ? 'active' : i < step ? 'done' : ''}`} aria-hidden="true" />
              <span className="sr-only">
                第 {i + 1} 步：{builderStepLabels[i]}
                {i === step ? '，当前步骤' : i < step ? '，已完成' : '，未开始'}
              </span>
            </div>
            {i < 3 && <div className="step-line" aria-hidden="true" />}
          </React.Fragment>
        ))}
      </div>

      {!isTrustedCity && step > 0 && (
        <div className="model-privacy-note" role="status" style={{ marginBottom: 20 }}>
          <AlertCircle size={15} />
          <p>{city}为试验生成，POI、营业信息和导航需人工复核。</p>
        </div>
      )}

      {/* Step 0: City */}
      {step === 0 && (
        <div className="builder-step">
          <h2 className="text-title">选择目的地</h2>
          <p className="text-caption" style={{ marginTop: 6 }}>
            首批可信城市为杭州、上海、苏州；其他城市仍可手动输入并试验生成
          </p>
          <div className="city-search-panel" style={{ marginTop: 20 }}>
            <label className="input-label" htmlFor="builder-city">
              目的地城市
            </label>
            <input
              id="builder-city"
              className="input-field"
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
            <datalist id="builder-city-options">
              {citySuggestions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <div className="city-suggestion-strip builder-city-strip" aria-label="首批可信城市">
              {trustedCities.map((item) => (
                <button
                  key={item}
                  aria-pressed={item === city}
                  className={item === city ? 'active' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commitCity(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          {!isTrustedCity && (
            <div className="model-privacy-note" role="status" style={{ marginTop: 20 }}>
              <AlertCircle size={15} />
              <p>{city}为试验生成，POI、营业信息和导航需人工复核。</p>
            </div>
          )}
        </div>
      )}

      {/* Step 1: Guide input */}
      {step === 1 && (
        <div className="builder-step">
          <h2 className="text-title">导入攻略与收藏</h2>
          <p className="text-caption" style={{ marginTop: 6 }}>
            粘贴公开链接、正文摘要、收藏地点或截图线索
          </p>
          <label className="sr-only" htmlFor="builder-guide">
            攻略链接、正文摘要或收藏地点
          </label>
          <textarea
            id="builder-guide"
            className="input-field"
            style={{ marginTop: 20 }}
            placeholder="例如：小红书/抖音/X 链接、攻略正文、想去的地点。无法公开抓取的链接请补充正文摘要。"
            value={guide}
            onChange={(e) => setGuide(e.target.value)}
          />
          <div className="import-tools">
            <div className="model-privacy-note" id="builder-upload-privacy">
              <AlertCircle size={15} />
              <p>
                隐私提示：截图会上传至当前配置的第三方模型服务进行 OCR
                处理。请先裁剪并移除姓名、手机号、订单号、证件、精确定位等敏感信息；选择文件即表示同意该处理。
              </p>
            </div>
            <label className="upload-tile" htmlFor="builder-screenshots">
              <ImageUp size={18} />
              <span>上传截图线索</span>
              <small>调用模型 OCR 提取地点/价格/时间</small>
              <input
                id="builder-screenshots"
                type="file"
                accept="image/*"
                multiple
                aria-describedby="builder-upload-privacy"
                onChange={handleScreenshotFiles}
              />
            </label>
            <div className="upload-tile muted">
              <Link size={18} />
              <span>公开链接分析</span>
              <small>不绕过登录墙，只分析公开可访问内容</small>
            </div>
          </div>
          {(urlsPendingImport.length > 0 || failedImportUrls.length > 0 || (importState.error && hasUrls)) && (
            <button
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => handleImportLinks({ retryFailed: failedImportUrls.length > 0 })}
              disabled={importState.loading}
            >
              {importState.loading ? <Loader2 size={14} className="spinner-icon" /> : <Link size={14} />}
              {importState.loading ? '导入中...' : failedImportUrls.length > 0 ? '重试失败链接' : '分析新增链接'}
            </button>
          )}
          {importState.error && (
            <div className="card-flat" role="alert" style={{ marginTop: 12, background: 'var(--orange-bg)' }}>
              <p className="text-caption" style={{ color: '#8A5200' }}>
                <AlertCircle size={13} /> {importState.error}
              </p>
            </div>
          )}
          {importState.sources.length > 0 && (
            <div className="card-flat source-analysis-card" style={{ marginTop: 12 }}>
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {importState.sources.length} 条来源已分析，来源预测均分 {averageSourcePrediction(importState.sources)}；该分数不代表真实到访验证
              </p>
              <div className="source-analysis-head">
                <strong>{importState.sources.length} 条来源已分析</strong>
                <span className={`badge ${sourcePredictionBadgeClass(averageSourcePrediction(importState.sources))}`}>
                  预测均分 {averageSourcePrediction(importState.sources)}
                </span>
              </div>
              {importState.sources.map((s, i) => (
                <div key={i} className="source-row">
                  <span className={`badge ${sourcePredictionBadgeClass(sourcePredictionValue(s))}`}>来源预测 {sourcePredictionValue(s) ?? '待计算'}</span>
                  <span className="text-caption">
                    {s.platform || '公开链接'} · {s.status || '状态待补充'} · {s.title?.slice(0, 30) || '标题待补充'}
                  </span>
                  {s.warnings?.[0] && <small>{s.warnings[0]}</small>}
                </div>
              ))}
            </div>
          )}
          <div className="candidate-poi-panel">
            <div className="source-analysis-head">
              <strong>候选地点确认</strong>
              <span className="badge badge-blue" role="status" aria-live="polite">
                {candidatePlaces.filter((place) => place.included).length} 个将参与生成
              </span>
            </div>
            <div className="candidate-add-row">
              <label className="sr-only" htmlFor="builder-manual-place">
                手动补充地点
              </label>
              <input
                id="builder-manual-place"
                className="input-field"
                value={manualPlace}
                onChange={(event) => setManualPlace(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addManualPlace();
                  }
                }}
                placeholder="手动补充地点，例如：法喜寺、武康路"
              />
              <button className="btn btn-secondary btn-sm" onClick={addManualPlace}>
                <Plus size={14} /> 添加
              </button>
            </div>
            {candidatePlaces.length ? (
              <div className="candidate-poi-list">
                {candidatePlaces.map((place, index) => (
                  <div key={`${place.name}-${index}`} className={`candidate-poi-row ${place.included ? '' : 'muted'}`}>
                    <label>
                      <input type="checkbox" checked={place.included} onChange={(event) => updateCandidate(index, { included: event.target.checked })} />
                      <span>
                        <strong>{place.name}</strong>
                        <small>
                          {place.source || '候选来源'} · 参考分 {place.confidence ?? '待计算'}
                          {place.note ? ` · ${place.note}` : ''}
                        </small>
                      </span>
                    </label>
                    <button
                      className={`btn btn-sm ${place.mustGo ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => updateCandidate(index, { mustGo: !place.mustGo, included: true })}
                    >
                      {place.mustGo ? <Check size={13} /> : <MapPin size={13} />} 必去
                    </button>
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => setCandidatePlaces((prev) => prev.filter((_, currentIndex) => currentIndex !== index))}
                      aria-label={`删除${place.name}`}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-caption">导入链接、上传截图或手动添加后，会在这里确认哪些地点进入路线；低参考分来源不会自动公开，只用于生成个人路书。</p>
            )}
          </div>
          {(ocrState.loading || ocrState.places.length > 0 || ocrState.warnings.length > 0) && (
            <div className="card-flat" role="status" aria-live="polite" aria-atomic="true" style={{ marginTop: 12 }}>
              <p className="text-caption">{ocrState.loading ? '正在识别截图中的地点、时间和价格...' : `截图识别完成：${ocrState.places.length} 个候选地点`}</p>
              {ocrState.places.slice(0, 6).map((place, i) => (
                <div key={`${place.name}-${i}`} className="source-row">
                  <span className={`badge ${place.confidence >= 70 ? 'badge-blue' : 'badge-orange'}`}>OCR {place.confidence ?? '待计算'}</span>
                  <span className="text-caption">
                    {place.name} · {place.time || '时间待复核'} · {place.price || '价格待复核'}
                  </span>
                </div>
              ))}
              {ocrState.warnings.map((warning, i) => (
                <p key={i} className="text-caption" style={{ marginTop: 6, color: 'var(--orange)' }}>
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 2: Constraints */}
      {step === 2 && (
        <div className="builder-step">
          <h2 className="text-title">旅行偏好</h2>
          <p className="text-caption" style={{ marginTop: 6 }}>
            设置约束条件，AI 会据此优化路线
          </p>

          <div className="field-grid" style={{ marginTop: 24 }}>
            <div>
              <label className="input-label" htmlFor="builder-date">
                <CalendarDays size={14} /> 出行日期
              </label>
              <input
                id="builder-date"
                className="input-field"
                type="date"
                value={constraints.date}
                onChange={(e) => setConstraints((p) => ({ ...p, date: e.target.value }))}
              />
            </div>
            <div>
              <label className="input-label" htmlFor="builder-base">
                <Home size={14} /> 住宿/出发地
              </label>
              <input
                id="builder-base"
                className="input-field"
                value={constraints.base}
                onChange={(e) => setConstraints((p) => ({ ...p, base: e.target.value }))}
                placeholder="湖滨银泰、杭州东站..."
              />
            </div>
          </div>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">行程天数</legend>
            <div className="chip-group">
              {durations.map((d) => (
                <button
                  key={d}
                  aria-pressed={constraints.duration === d}
                  className={`chip ${constraints.duration === d ? 'active' : ''}`}
                  onClick={() => setConstraints((p) => ({ ...p, duration: d }))}
                >
                  {d}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">预算</legend>
            <div className="chip-group">
              {budgets.map((b) => (
                <button
                  key={b}
                  aria-pressed={constraints.budget === b}
                  className={`chip ${constraints.budget === b ? 'active' : ''}`}
                  onClick={() => setConstraints((p) => ({ ...p, budget: b }))}
                >
                  {b}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">节奏</legend>
            <div className="chip-group">
              {tempos.map((t) => (
                <button
                  key={t}
                  aria-pressed={constraints.tempo === t}
                  className={`chip ${constraints.tempo === t ? 'active' : ''}`}
                  onClick={() => setConstraints((p) => ({ ...p, tempo: t }))}
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">同行</legend>
            <div className="chip-group">
              {companions.map((c) => (
                <button
                  key={c}
                  aria-pressed={constraints.companion === c}
                  className={`chip ${constraints.companion === c ? 'active' : ''}`}
                  onClick={() => setConstraints((p) => ({ ...p, companion: c }))}
                >
                  {c}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">
              <Train size={14} /> 交通偏好
            </legend>
            <div className="chip-group">
              {transports.map((t) => (
                <button
                  key={t}
                  aria-pressed={constraints.transport === t}
                  className={`chip ${constraints.transport === t ? 'active' : ''}`}
                  onClick={() => setConstraints((p) => ({ ...p, transport: t }))}
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="builder-fieldset" style={{ marginTop: 20 }}>
            <legend className="input-label">主题偏好</legend>
            <div className="chip-group">
              {themes.map((t) => (
                <button
                  key={t}
                  aria-pressed={constraints.theme.includes(t)}
                  className={`chip ${constraints.theme.includes(t) ? 'active' : ''}`}
                  onClick={() => toggleTheme(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>

          <div style={{ marginTop: 20, display: 'grid', gap: 12 }}>
            <div>
              <label className="input-label" htmlFor="builder-must-go">
                必去地点
              </label>
              <input
                id="builder-must-go"
                className="input-field"
                value={constraints.mustGo}
                onChange={(e) => setConstraints((p) => ({ ...p, mustGo: e.target.value }))}
                placeholder="西湖、法喜寺"
              />
            </div>
            <div>
              <label className="input-label" htmlFor="builder-avoid">
                避开
              </label>
              <input
                id="builder-avoid"
                className="input-field"
                value={constraints.avoid}
                onChange={(e) => setConstraints((p) => ({ ...p, avoid: e.target.value }))}
                placeholder="排队过久、商业街同质化"
              />
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Generating */}
      {step === 3 && (
        <div className="builder-step" style={{ textAlign: 'center', paddingTop: 60 }}>
          <div className="gen-animation">
            <Sparkles size={40} style={{ color: 'var(--blue)' }} />
          </div>
          <h2 className="text-title" style={{ marginTop: 24 }}>
            正在生成路书
          </h2>
          <p className="text-caption" style={{ marginTop: 8 }}>
            {city} · {constraints.duration}
          </p>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {genSteps.length ? `生成进度：${genSteps.at(-1)}` : '正在准备生成'}
          </p>

          <div className="gen-steps" role="list" aria-label="路书生成进度" style={{ marginTop: 32, textAlign: 'left', maxWidth: 320, margin: '32px auto 0' }}>
            {genSteps.map((s, i) => (
              <div key={i} className="gen-step-item" role="listitem">
                {i === genSteps.length - 1 && loading ? (
                  <div className="spinner" style={{ width: 16, height: 16 }} />
                ) : (
                  <Check size={16} style={{ color: 'var(--green)' }} />
                )}
                <span className="text-body">{s}</span>
              </div>
            ))}
          </div>

          {error && (
            <div className="card-flat" role="alert" style={{ marginTop: 24, background: 'var(--red-bg)', textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertCircle size={16} style={{ color: 'var(--red)' }} />
                <span className="text-caption" style={{ color: 'var(--red)' }}>
                  {error}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                <button className="btn btn-primary btn-sm" onClick={retryGenerate}>
                  <Sparkles size={14} /> 重试生成
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setStep(2)}>
                  <ArrowLeft size={14} /> 返回偏好
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      {step < 3 && (
        <div className="builder-nav">
          <button className="btn btn-secondary" onClick={() => (step > 0 ? setStep((s) => s - 1) : leaveBuilder())}>
            <ArrowLeft size={16} /> {step === 0 ? '取消' : '上一步'}
          </button>
          <button
            className="btn btn-primary"
            onClick={next}
            disabled={!canProceed || importState.loading || ocrState.loading || (!modelHealth?.ready && step === 2)}
          >
            {ocrState.loading ? (
              <>
                <Loader2 size={16} className="spinner-icon" /> 截图识别中...
              </>
            ) : step === 2 ? (
              <>
                <Sparkles size={16} /> 生成路书
              </>
            ) : (
              <>
                下一步 <ArrowRight size={16} />
              </>
            )}
          </button>
        </div>
      )}
      {step === 2 && !modelHealth?.ready && (
        <div className="card-flat" role="alert" style={{ marginTop: 14, background: 'var(--orange-bg)' }}>
          <p className="text-caption" style={{ color: '#8A5200' }}>
            模型暂未就绪：{modelHealth?.reason || '请确认 Codex yinyue 的 base url 和 API key 可用'}。当前表单内容会保留在页面中，模型恢复后可直接生成。
          </p>
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

function averageSourcePrediction(sources) {
  if (!sources.length) return 0;
  const scores = sources.map(sourcePredictionValue).filter((score) => score != null);
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
}

function sourcePredictionValue(source) {
  const value = source?.predictionScore ?? source?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function sourcePredictionBadgeClass(score) {
  if (score == null || score >= 70) return 'badge-blue';
  return score >= 45 ? 'badge-orange' : 'badge-red';
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

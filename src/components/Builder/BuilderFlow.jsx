import { useEffect, useMemo, useRef, useState } from 'react';
import { trackFunnel } from '../../lib/betaTelemetry.js';
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { analyzeGuideImages, checkHealth, getApiToken, getCities, importGuide, saveProfile, setApiToken, startGenerationJob } from '../../lib/api';
import {
  cancelActiveGeneration,
  clearActiveGenerationJob,
  followGenerationJob,
  generationFailureCopy,
  isAccessCodeError,
  readActiveGenerationJob,
  saveActiveGenerationJob
} from '../../lib/generationJob';
import { trustedCities } from '../../lib/content';
import { createRouteEditToken, getProfile, profileRoutebookFields, updateProfile } from '../../lib/profile';
import { adoptServerProfile } from '../../lib/profileSync';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Field, inputClass } from '../ui/field';
import { Notice, StepCity, StepGuide, StepPrefs, Stepper } from './BuilderSteps';
import { GenerationProgress } from './GenerationProgress';
import { readGenerationMode, rememberGenerationMode } from '../../lib/generationModes';
import { BUDGET_OPTIONS, mergeMustGoConstraint } from './builderModel';
import { candidatesForPrefilledGuide, extractPlaceCandidates, reconcileTextCandidates } from '../../lib/placeCandidates';
import { knownPoiCoordinates } from '../../lib/coordinates';
import { useAccount } from '../Account/AccountProvider';

const defaultConstraints = {
  duration: '2 天 1 晚',
  // No silent default: an empty budget means "no budget constraint".
  budget: '',
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
// Labels say whether the amount is per person for the whole trip or per day.
const budgets = BUDGET_OPTIONS.map((option) => option.label);
const tempos = ['少走路', '松弛但不空', '高密度打卡'];
const companions = ['独行', '情侣', '朋友', '亲子'];
const transports = ['步行 + 打车', '地铁优先', '少换乘', '亲子少走路'];
const themes = ['Citywalk', '美食拍照', '寺院茶山', '展览咖啡', '园林夜游', '亲子慢游'];
const builderStepLabels = ['选择目的地', '导入攻略与收藏', '设置旅行偏好', '生成路书'];
const BUILDER_DRAFT_PREFIX = 'trusted-routebook:builder-draft:v1';
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

/** @param {{ modelHealth?: any, defaults?: Record<string, any>, onGenerated?: Function, onProfileChanged?: Function, onModelHealth?: Function, onBack?: Function }} props */
/** @param {Record<string, any>} props */
export default function BuilderFlow({ modelHealth, defaults = {}, onGenerated, onProfileChanged, onModelHealth, onBack }) {
  useEffect(() => trackFunnel('create_start'), []);
  const [profile, setProfile] = useState(() => getProfile());
  const { required: loginRequired, account, generation, requireLogin, openLogin, refresh: refreshAccount } = useAccount();
  const needsLogin = loginRequired && !account;
  // Guests can look around and type; the steps that call AI ask for a login first, then carry on.
  const nextRef = useRef(/** @type {() => void} */ (() => {}));
  const guardLogin = (reason, resume) =>
    requireLogin(reason, () => {
      setProfile(getProfile());
      resume?.();
    });
  const [savedDraft] = useState(() => readBuilderDraft(profile.id));
  const hasPendingDraft = hasBuilderDefaults(defaults) && Boolean(savedDraft);
  const [draftResolution, setDraftResolution] = useState(() => (hasPendingDraft ? 'pending' : 'resolved'));
  const initialDraft = hasBuilderDefaults(defaults) ? null : savedDraft;
  const [apiTokenInput, setApiTokenInput] = useState(() => getApiToken());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const apiTokenInputRef = useRef(null);
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
  // Async generation job (server snapshot) and how this run ended.
  const [generationJob, setGenerationJob] = useState(null);
  const [generationOutcome, setGenerationOutcome] = useState(null);
  const [generationFailure, setGenerationFailure] = useState(null);
  const [generationMode, setGenerationModeState] = useState(() => readGenerationMode());
  useEffect(() => {
    if (step === 2 && account) refreshAccount().catch(() => {});
  }, [step, account?.profileId, refreshAccount]);
  const setGenerationMode = (/** @type {string} */ next) => {
    setGenerationModeState(next);
    rememberGenerationMode(next);
  };
  const [cancelState, setCancelState] = useState({ busy: false, error: '' });
  const activeJobRef = useRef(null);
  const [importState, setImportState] = useState({ loading: false, sources: initialDraft?.importedSources ?? [], error: '' });
  const [ocrState, setOcrState] = useState({ loading: false, places: initialDraft?.ocrPlaces ?? [], warnings: initialDraft?.ocrWarnings ?? [] });
  const [initialCandidatePlaces] = useState(() =>
    defaults.guide ? candidatesForPrefilledGuide(defaults.guide, [], { knownPlaces: knownPlacesForCity(initialCity) }) : (initialDraft?.candidatePlaces ?? [])
  );
  const [candidatePlaces, setCandidatePlaces] = useState(initialCandidatePlaces);
  const [manualPlace, setManualPlace] = useState(initialDraft?.manualPlace ?? '');
  const mountedRef = useRef(true);
  const guideRef = useRef(defaults.guide ?? initialDraft?.guide ?? '');
  const candidatePlacesRef = useRef(initialCandidatePlaces);
  const importSourcesRef = useRef(initialDraft?.importedSources ?? []);
  const generationSequence = useRef(0);
  const generationAbort = useRef(null);
  const generationTimeout = useRef(null);
  const importAbort = useRef(null);
  const importPromise = useRef(null);
  const autoImportStarted = useRef(false);
  const ocrAbort = useRef(null);

  useEffect(() => {
    // 带默认值进入新建流程时，先让用户决定是否覆盖已有草稿；在决定前不得覆盖旧草稿。
    if (draftResolution === 'pending') return;
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
    step,
    draftResolution
  ]);

  useEffect(() => {
    mountedRef.current = true;
    // A job started before a reload (or before leaving the builder) is resumed, not restarted.
    const active = readActiveGenerationJob();
    let resumeTimer = 0;
    if (active && (!active.profileId || active.profileId === getProfile().id)) {
      resumeTimer = window.setTimeout(() => resumeGeneration(active), 0);
    }
    return () => {
      mountedRef.current = false;
      window.clearTimeout(resumeTimer);
      // Leaving only stops watching: the server job keeps running and can be resumed.
      stopFollowingGeneration();
      importAbort.current?.abort();
      ocrAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resume once on mount.
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

  const hasGuideInput = hasActionableGuideInput({ guide, sources: importState.sources, candidates: candidatePlaces, ocrPlaces: ocrState.places });
  const [cityClosed, setCityClosed] = useState(false);
  const canProceed = step === 0 ? Boolean(cityQuery.trim()) && !cityClosed : step === 1 ? hasGuideInput : step === 2;
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
          // 服务端按开放范围（默认江浙沪）回答这个城市能不能生成。
          setCityClosed(Boolean(cityQuery.trim()) && data.supported === false && data.openRegion === 'jzh');
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
        setImportState((prev) => {
          const sources = mergeImportedSources(prev.sources, data.sources ?? []);
          importSourcesRef.current = sources;
          return { loading: false, sources, error: '' };
        });
        if (data.guideText)
          setGuide((prev) => {
            const next = prev.includes(data.guideText) ? prev : [prev.trim(), data.guideText].filter(Boolean).join('\n\n');
            guideRef.current = next;
            return next;
          });
        addCandidatePlaces(extractCandidatePlacesFromSources(data.sources ?? [], knownPlacesForCity(city)));
        return true;
      })
      .catch((e) => {
        if (!mountedRef.current || ctrl.signal.aborted) return false;
        setImportState((prev) => ({ ...prev, loading: false, error: e.message }));
        setError(e.message);
        if (isAccessCodeError(e)) openAccessCode();
        return false;
      })
      .finally(() => {
        if (importPromise.current === task) importPromise.current = null;
      });
    importPromise.current = task;
    return task;
  }

  async function handleGenerate(modeOverride = '') {
    const mode = modeOverride || generationMode;
    stopFollowingGeneration();
    const generationId = generationSequence.current;
    const ctrl = new AbortController();
    generationAbort.current = ctrl;
    setLoading(true);
    setError('');
    setGenerationFailure(null);
    setCancelState({ busy: false, error: '' });
    setGenerationJob(null);
    setGenerationOutcome('starting');

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
      const data = await startGenerationJob(
        {
          city,
          mode,
          guide: fullGuide,
          profileId: activeProfile.id,
          editToken: createRouteEditToken(),
          guideOrigins: ocrState.places.length ? ['ocr'] : [],
          constraints: {
            ...constraints,
            // Places marked 必去 in the candidate list are must-go constraints too, so the
            // routebook's 必去与避开 check and the constraint metrics can verify them.
            mustGo: mergeMustGoConstraint(constraints.mustGo, candidatePlaces),
            theme: constraints.theme?.join('、')
          },
          importedSources: importState.sources
        },
        ctrl.signal
      );
      if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
      saveActiveGenerationJob({ jobId: data.job.jobId, profileId: activeProfile.id, city, duration: constraints.duration, startedAt: data.job.createdAt });
      await followJob(data.job, activeProfile.id, ctrl, generationId);
    } catch (e) {
      if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
      failGeneration(e);
    }
  }

  function resumeGeneration(active) {
    stopFollowingGeneration();
    const generationId = generationSequence.current;
    const ctrl = new AbortController();
    generationAbort.current = ctrl;
    if (active.city) {
      setCity(active.city);
      setCityQuery(active.city);
    }
    if (active.duration) setConstraints((prev) => ({ ...prev, duration: active.duration }));
    setStep(3);
    setLoading(true);
    setGenerationFailure(null);
    setGenerationOutcome('running');
    followJob({ jobId: active.jobId, seq: 0, status: 'running', elapsedMs: 0, createdAt: active.startedAt, stages: [] }, active.profileId, ctrl, generationId, {
      resumed: true
    }).catch((e) => {
      if (!mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId) return;
      clearActiveGenerationJob(active.jobId);
      failGeneration(e);
    });
  }

  async function followJob(initialJob, profileId, ctrl, generationId, { resumed = false } = {}) {
    activeJobRef.current = { jobId: initialJob.jobId, profileId };
    const stale = () => !mountedRef.current || ctrl.signal.aborted || generationSequence.current !== generationId;
    if (!resumed) setGenerationJob({ ...initialJob, receivedAt: Date.now() });
    setGenerationOutcome('running');
    const final = ['succeeded', 'failed', 'cancelled'].includes(initialJob.status)
      ? initialJob
      : await followGenerationJob(initialJob.jobId, {
          profileId,
          after: resumed ? 0 : initialJob.seq,
          signal: ctrl.signal,
          onUpdate: (job) => {
            if (!stale()) setGenerationJob({ ...job, receivedAt: Date.now() });
          }
        });
    if (stale()) return;
    finishGeneration(final);
  }

  function finishGeneration(job) {
    clearActiveGenerationJob(job.jobId);
    activeJobRef.current = null;
    setGenerationJob({ ...job, receivedAt: Date.now() });
    setCancelState({ busy: false, error: '' });
    if (job.status === 'succeeded') {
      setGenerationOutcome('succeeded');
      const generationId = generationSequence.current;
      const activeProfile = getProfile();
      // A short pause shows the completed checklist before the routebook opens.
      generationTimeout.current = setTimeout(() => {
        if (mountedRef.current && generationSequence.current === generationId) {
          clearBuilderDraft(activeProfile.id);
          onGenerated({ ...job.result, ...profileRoutebookFields(activeProfile) });
        }
      }, 900);
      return;
    }
    setLoading(false);
    if (job.status === 'cancelled') {
      setGenerationOutcome('cancelled');
      return;
    }
    failGeneration(job.error ?? {});
  }

  // Opens 高级设置 and focuses the access-code field (before the user spends time on the form).
  function openAccessCode() {
    setAdvancedOpen(true);
    window.setTimeout(() => apiTokenInputRef.current?.focus(), 0);
  }

  function refreshModelHealth() {
    checkHealth()
      .then((health) => {
        if (mountedRef.current) onModelHealth?.(health);
      })
      .catch(() => {});
  }

  function failGeneration(e) {
    setLoading(false);
    setGenerationOutcome('failed');
    setGenerationFailure({ ...generationFailureCopy(e), code: e?.code ?? '', suggestDeep: e?.suggestDeep === true });
    if (isAccessCodeError(e)) openAccessCode();
    checkHealth()
      .then((health) => {
        if (mountedRef.current) onModelHealth?.(health);
      })
      .catch(() => {
        if (mountedRef.current) onModelHealth?.({ ok: false, ready: false, reason: '模型服务检查失败' });
      });
  }

  async function handleCancelGeneration() {
    const active = activeJobRef.current;
    if (!active || cancelState.busy) return;
    setCancelState({ busy: true, error: '' });
    try {
      const data = await cancelActiveGeneration(active.jobId, active.profileId);
      if (!mountedRef.current) return;
      stopFollowingGeneration();
      finishGeneration(data.job);
    } catch (e) {
      if (!mountedRef.current) return;
      setCancelState({ busy: false, error: `取消没有成功：${e.message}。生成仍在进行，可以稍后再试。` });
    }
  }

  function retryGenerate(modeOverride = '') {
    if (loading) return;
    const mode = typeof modeOverride === 'string' ? modeOverride : '';
    // Switching to 细品 after a failed 轻快 run is the user's choice; it is remembered for next time.
    if (mode) setGenerationMode(mode);
    if (!guardLogin('生成路书要用到 AI。登录后会接着生成。', () => handleGenerate(mode))) return;
    handleGenerate(mode);
  }

  function stopFollowingGeneration() {
    generationSequence.current += 1;
    generationAbort.current?.abort();
    generationAbort.current = null;
    clearTimeout(generationTimeout.current);
    generationTimeout.current = null;
  }

  function leaveBuilder() {
    stopFollowingGeneration();
    onBack();
  }

  async function next() {
    if (step >= 1 && !guardLogin('这一步要用 AI，需要先登录。你填的内容都在，登录后接着往下走。', () => nextRef.current())) return;
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
      if (
        !hasActionableGuideInput({
          guide: guideRef.current,
          sources: importSourcesRef.current,
          candidates: candidatePlacesRef.current,
          ocrPlaces: ocrState.places
        })
      ) {
        setError('还缺内容：贴一段攻略正文或写下需求，或手动加几个地点。只有链接标题或截图文件名，没法生成。');
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setStep(3);
      handleGenerate();
    } else setStep((s) => s + 1);
  }

  nextRef.current = next;

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
    if (!guardLogin('识别截图要用到 AI，登录后再选一次截图就行。')) return;
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
          origin: 'ocr',
          // OCR "confidence" is the model's own guess; it is not shown as a score.
          confidence: null,
          reason: 'OCR 识别，请核对名称',
          note: [place.time, place.price, place.note].filter(Boolean).join(' · '),
          included: false,
          decided: false,
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
        // A decision the user already made (checked/unchecked/必去) is never overridden by a new source.
        const keepDecision = existing?.decided === true;
        map.set(key, {
          ...existing,
          name: existing?.name ?? place.name,
          source: existing?.source && existing.source !== place.source ? `${existing.source}、${place.source}` : place.source || '手动补充',
          // Once another source confirms a guide-text candidate it is no longer removed with the text.
          origin: existing && existing.origin !== place.origin ? 'multiple' : place.origin || 'manual',
          confidence: place.confidence ?? existing?.confidence ?? null,
          reason: place.reason || existing?.reason || '',
          note: place.note || existing?.note || '',
          included: keepDecision ? existing.included : (place.included ?? existing?.included ?? false),
          decided: keepDecision || place.decided === true,
          mustGo: keepDecision ? existing.mustGo : (place.mustGo ?? existing?.mustGo ?? false)
        });
      }
      const next = [...map.values()].slice(0, 24);
      candidatePlacesRef.current = next;
      return next;
    });
  }

  function handleGuideChange(value) {
    guideRef.current = value;
    setGuide(value);
    // Re-derive text candidates from the whole text: removed text removes its candidates.
    setCandidatePlaces((prev) => {
      const next = reconcileTextCandidates(prev, extractPlaceCandidates(value, { knownPlaces: knownPlacesForCity(city) }));
      candidatePlacesRef.current = next;
      return next;
    });
  }

  function resumeSavedDraft() {
    if (!savedDraft) return;
    setCity(savedDraft.city ?? city);
    setCityQuery(savedDraft.cityQuery ?? savedDraft.city ?? cityQuery);
    guideRef.current = savedDraft.guide ?? '';
    setGuide(savedDraft.guide ?? '');
    setConstraints({ ...defaultConstraints, ...(savedDraft.constraints ?? {}) });
    setScreenshotNotes(savedDraft.screenshotNotes ?? []);
    const sources = savedDraft.importedSources ?? [];
    importSourcesRef.current = sources;
    setImportState({ loading: false, sources, error: '' });
    const places = savedDraft.ocrPlaces ?? [];
    setOcrState({ loading: false, places, warnings: savedDraft.ocrWarnings ?? [] });
    const candidates = savedDraft.candidatePlaces ?? [];
    candidatePlacesRef.current = candidates;
    setCandidatePlaces(candidates);
    setManualPlace(savedDraft.manualPlace ?? '');
    setStep(Math.min(2, Math.max(0, Number(savedDraft.step) || 0)));
    setDraftResolution('resume');
  }

  function startNewBuilder() {
    setDraftResolution('new');
  }

  function addManualPlace() {
    const name = manualPlace.trim();
    if (!name) return;
    addCandidatePlaces([{ name, source: '手动补充', origin: 'manual', confidence: null, reason: '你手动添加', included: true, decided: true, mustGo: true }]);
    setManualPlace('');
  }

  function updateCandidate(index, patch) {
    setCandidatePlaces((prev) => {
      const next = prev.map((place, currentIndex) => (currentIndex === index ? { ...place, ...patch, decided: true } : place));
      candidatePlacesRef.current = next;
      return next;
    });
  }

  const needsAccessCode = modelHealth?.access === 'needs-access-code' && modelHealth?.modelReady !== false;
  // Open 高级设置 once when the site turns out to need an access code; the user can still close it.
  useEffect(() => {
    if (needsAccessCode) setAdvancedOpen(true);
  }, [needsAccessCode]);
  const quotaExhausted = Boolean(account && generation?.limited);
  const nextDisabled =
    draftResolution === 'pending' ||
    !canProceed ||
    importState.loading ||
    ocrState.loading ||
    (!modelHealth?.ready && step === 2) ||
    (quotaExhausted && step === 2);

  return (
    <div className={cn("page-enter mx-auto max-w-[760px] px-4 pt-5 lg:pt-8", step === 2 ? "pb-44 sm:pb-40" : "pb-32")}>
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={leaveBuilder}>
          <ArrowLeft /> 返回
        </Button>
        {!loginRequired && (
          <details className="group relative text-sm" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary
              className={cn(
                'cursor-pointer list-none rounded-full px-3 py-1.5 font-semibold hover:bg-canvas',
                needsAccessCode ? 'bg-lemon-soft text-lemon-ink' : 'text-muted'
              )}
            >
              高级设置{needsAccessCode ? ' · 需要访问码' : ''}
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-72 rounded-card border border-line bg-white p-4 shadow-pop">
              <Field label="访问码" hint="向站点运营方获取">
                <input
                  id="builder-api-token"
                  ref={apiTokenInputRef}
                  className={inputClass}
                  type="password"
                  value={apiTokenInput}
                  onChange={(event) => setApiTokenInput(event.target.value)}
                  onBlur={() => {
                    setApiToken(apiTokenInput);
                    refreshModelHealth();
                  }}
                  placeholder="填写访问码"
                  aria-invalid={needsAccessCode || undefined}
                  aria-describedby={needsAccessCode ? 'builder-api-token-hint' : undefined}
                />
              </Field>
              {needsAccessCode && (
                <p id="builder-api-token-hint" className="mt-2 text-xs font-semibold text-lemon-ink">
                  {apiTokenInput ? '访问码不对，请检查后重新填写。' : '这个站点生成路书需要访问码。填好后点别处，会自动检查。'}
                </p>
              )}
            </div>
          </details>
        )}
      </div>

      {(() => {
        // 合并原先叠在步骤上方的 3–4 条提示：只出一条，按「会挡住生成」的优先级排列。
        if (step >= 3) return null;
        const parts = [];
        if (needsAccessCode) parts.push(<span key="code">这个站点要访问码才能生成。 <button type="button" className="relative -my-2 inline-block py-2 font-bold underline underline-offset-2" onClick={openAccessCode}>填写访问码</button></span>);
        if (defaults?.quotaWarning) parts.push(<span key="quota">{defaults.quotaWarning}</span>);
        if (!isTrustedCity && step > 0) parts.push(<span key="trial">{city} 暂时只能生成 AI 草稿，地点和营业时间出发前要自己确认。</span>);
        if (needsLogin) parts.push(<span key="login">可以先填着，点生成时再登录，内容会留着。 <button type="button" className="relative -my-2 inline-block py-2 font-bold underline underline-offset-2" onClick={() => openLogin('login')}>现在登录</button></span>);
        else if (!account && step >= 1) parts.push(<span key="login">登录后路书存进账号，换设备也能看。 <button type="button" className="relative -my-2 inline-block py-2 font-bold underline underline-offset-2" onClick={() => openLogin('login')}>登录 / 注册</button></span>);
        if (!parts.length) return null;
        return (
          <Notice className="mt-3" tone={needsAccessCode || defaults?.quotaWarning ? 'warn' : 'sky'} data-testid="builder-notice">
            <span className="flex flex-col gap-1">{parts}</span>
          </Notice>
        );
      })()}

      <header className="mt-3">
        <span className="text-xs font-extrabold tracking-[0.08em] text-primary-strong">
          创建我的路书 · 第 {step + 1} 步，共 {builderStepLabels.length} 步
        </span>
        <div className="mt-3">
          <Stepper labels={builderStepLabels} step={step} />
        </div>
      </header>

      {draftResolution === 'pending' && savedDraft && (
        <Notice role="alert" className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>发现一份未完成草稿（{formatDraftTime(savedDraft.updatedAt)}）。请选择继续草稿，或用本次入口的新内容开始，避免误覆盖。</span>
            <span className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={resumeSavedDraft}>
                继续草稿
              </Button>
              <Button size="sm" variant="primary" onClick={startNewBuilder}>
                使用本次内容
              </Button>
            </span>
          </div>
        </Notice>
      )}


      <div className="mt-8">
        {step === 0 && (
          <StepCity
            cityQuery={cityQuery}
            setCityQuery={setCityQuery}
            citySuggestions={citySuggestions}
            commitCity={commitCity}
            city={city}
            isTrustedCity={isTrustedCity}
            cityClosed={cityClosed}
          />
        )}
        {step === 1 && (
          <StepGuide
            city={city}
            guide={guide}
            setGuide={handleGuideChange}
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
            mode={generationMode}
            setMode={setGenerationMode}
            generation={account ? generation : null}
          />
        )}
        {step === 3 && (
          <GenerationProgress
            job={generationJob}
            outcome={generationOutcome}
            failure={generationFailure}
            city={city}
            duration={constraints.duration}
            cancelling={cancelState.busy}
            cancelError={cancelState.error}
            onCancel={handleCancelGeneration}
            onRetry={() => retryGenerate()}
            onRetryDeep={() => retryGenerate('deep')}
            mode={generationJob?.mode || generationMode}
            onBackToPrefs={() => setStep(2)}
          />
        )}
      </div>

      {step < 3 && error && (
        <Notice role="alert" tone="bad" className="mt-6">
          {error}
        </Notice>
      )}

      {step === 2 && !modelHealth?.ready && (
        <Notice role="alert" className="mt-6">
          {needsAccessCode
            ? '需要平台访问码：请在右上角「高级设置」填写访问码。表单内容会保留，填写后即可生成。'
            : `模型暂未就绪：${modelHealth?.reason || '请确认模型服务的 base URL 和 API key 可用'}。表单内容会保留，模型恢复后可以直接生成。`}
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
                  <Sparkles /> {quotaExhausted ? '次数已用完' : '生成路书'}
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

function formatDraftTime(value) {
  const time = Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time);
}

function builderDraftKey(profileId) {
  return `${BUILDER_DRAFT_PREFIX}:${encodeURIComponent(String(profileId || 'anonymous'))}`;
}

function buildCandidateGuide(candidatePlaces) {
  const included = candidatePlaces.filter((place) => place.included);
  // Unreviewed candidates are neither confirmed nor excluded; only explicit unchecks are exclusions.
  const excluded = candidatePlaces.filter((place) => !place.included && place.decided === true);
  if (!included.length && !excluded.length) return '';
  return [
    included.length
      ? `用户确认进入路线的候选 POI：${included.map((place) => `${place.mustGo ? '必去-' : ''}${place.name}（${place.source || '候选来源'}${place.note ? `，${place.note}` : ''}）`).join('；')}`
      : '',
    excluded.length ? `用户已排除的 POI：${excluded.map((place) => place.name).join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function hasActionableGuideInput({ guide = '', sources = [], candidates = [], ocrPlaces = [] } = {}) {
  if (Array.isArray(candidates) && candidates.some((place) => place.included)) return true;
  if (Array.isArray(ocrPlaces) && ocrPlaces.length > 0) return true;
  if (
    Array.isArray(sources) &&
    sources.some((source) => {
      if (source?.status !== 'fetched') return false;
      return [source.description, source.excerpt, source.content, source.guideText].some((value) => String(value ?? '').trim().length >= 20);
    })
  ) {
    return true;
  }
  const text = String(guide ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const value = line.trim();
      return value && !/^(?:来源\s*\d+|标题|摘要|公开正文摘录|可信信号|风险提示|链接)[:：]/.test(value) && !/^已上传截图[:：]/.test(value);
    })
    .join('\n')
    .replace(/https?:\/\/[^\s"'<>，。；、)）]+/gi, '')
    .replace(/截图暂未识别成功[^\n。]*[。]?/g, '')
    .trim();
  return text.length >= 8;
}

function extractCandidatePlacesFromSources(sources, knownPlaces = []) {
  const rows = [];
  for (const source of sources) {
    const text = `${source.title ?? ''}\n${source.description ?? ''}\n${source.excerpt ?? ''}`;
    for (const place of extractPlaceCandidates(text, { knownPlaces })) {
      if (place.intent === 'avoid') continue;
      rows.push({
        name: place.name,
        source: source.platform || '导入来源',
        origin: 'source',
        confidence: place.confidence,
        reason: place.reason,
        note: source.warnings?.[0] || '',
        included: false,
        decided: false,
        mustGo: false
      });
    }
  }
  return rows.slice(0, 18);
}

function knownPlacesForCity(city) {
  return Object.entries(knownPoiCoordinates)
    .filter(([, entry]) => !city || entry.city === String(city).replace(/市$/u, ''))
    .map(([name]) => name);
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

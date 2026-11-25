import { useId, useState } from 'react';
import { Check, LocateFixed, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Field, inputClass } from '../ui/field';
import { grantLocationConsent, requestPositionWithConsent } from '../../lib/locationConsent.js';
import LocationConsentDialog from './LocationConsentDialog';

// 本地暂存照片 dataURL 上限（约 400KB），防 localStorage 被撑爆。
const MAX_PHOTO_DATA_URL_LENGTH = 400 * 1024;

const QUEUE_QUICK_OPTIONS = [
  { label: '不用排', value: '0 分钟' },
  { label: '15 分钟内', value: '15 分钟' },
  { label: '30 分钟左右', value: '30 分钟' },
  { label: '1 小时以上', value: '60 分钟' }
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('照片读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('照片解码失败'));
    image.src = dataUrl;
  });
}

async function compressImageToDataUrl(file, maxEdge = 1280, quality = 0.8) {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(sourceDataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error('照片内容为空');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持照片压缩');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** @param {Record<string, any>} props */
export default function CheckinForm({ onSubmit, onCancel, travelers = ['我'], onAddTraveler = undefined }) {
  const fieldPrefix = useId().replaceAll(':', '');
  const [queue, setQueue] = useState('');
  const [cost, setCost] = useState('');
  const [paidBy, setPaidBy] = useState('我');
  const [splitWith, setSplitWith] = useState(() => (Array.isArray(travelers) && travelers.length ? travelers : ['我']));
  const [newTraveler, setNewTraveler] = useState('');
  const [worth, setWorth] = useState('');
  const [crowd, setCrowd] = useState('');
  const [comment, setComment] = useState('');
  const [pitfall, setPitfall] = useState('');
  const [audience, setAudience] = useState('');
  const [photoName, setPhotoName] = useState('');
  const [photoData, setPhotoData] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [gps, setGps] = useState(null);
  const [gpsError, setGpsError] = useState('');
  const [consentOpen, setConsentOpen] = useState(false);

  function locate() {
    setGpsError('');
    const result = requestPositionWithConsent({
      geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : null,
      onPosition: (position) =>
        setGps({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
          accuracy: Math.round(position.coords.accuracy),
          // 客户端无法可靠判定浏览器返回的坐标系，标注 unknown 交由服务端双算纠偏。
          coordinateSystem: 'unknown',
          userAgent: String(navigator.userAgent ?? '').slice(0, 160)
        }),
      onError: () => setGpsError('没拿到定位，仍可保存；这条作为普通反馈记录。'),
      options: { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    });
    // 未同意前绝不调用定位 API：先弹出说明，用户同意后再请求。
    if (result === 'needs-consent') setConsentOpen(true);
    if (result === 'unsupported') setGpsError('当前浏览器不支持定位，仍可直接保存。');
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    setPhotoError('');
    setPhotoData('');
    setPhotoName(file?.name ?? '');
    if (!file) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await compressImageToDataUrl(file, 1280, 0.8);
      if (dataUrl.length > MAX_PHOTO_DATA_URL_LENGTH) {
        setPhotoError('照片压缩后仍超过 400KB，本次不上传；请稍后重拍或换一张照片。');
        return;
      }
      setPhotoData(dataUrl);
    } catch {
      setPhotoError('照片处理失败，本次不上传；仍可直接记录到达。');
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (photoBusy) return;
        onSubmit({ queue, cost, paidBy, splitWith, worth, crowd, comment, pitfall, audience, photoName, photoData, gps });
      }}
    >
      <ChoiceGroup label="值不值得去" options={['值得', '一般', '踩坑']} value={worth} onChange={setWorth} />
      <ChoiceGroup label="现场人多吗" options={['清净', '适中', '拥挤', '人挤人']} value={crowd} onChange={setCrowd} />
      <fieldset>
        <legend className="mb-2 text-sm font-bold text-ink-2">排队多久（选填）</legend>
        <div className="flex flex-wrap gap-2">
          {QUEUE_QUICK_OPTIONS.map((opt) => {
            const active = queue === opt.value;
            return (
              <button
                type="button"
                key={opt.value}
                aria-pressed={active}
                onClick={() => setQueue(active ? '' : opt.value)}
                className={cn(
                  'min-h-11 rounded-full px-3.5 text-sm font-semibold sm:min-h-10',
                  active ? 'bg-ink text-white' : 'bg-canvas text-ink-2 hover:bg-line'
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-canvas p-3">
        <span className="min-w-0 flex-1 text-meta text-muted">
          {gps ? (
            <span className="font-semibold text-success-ink">已附带当前定位（精度约 {gps.accuracy} 米）</span>
          ) : (
            gpsError || '顺手附带定位可帮后来人确认这里正常开放（选填）'
          )}
        </span>
        <Button size="sm" variant={gps ? 'soft' : 'outline'} onClick={locate}>
          <LocateFixed /> {gps ? '刷新定位' : '附带定位'}
        </Button>
      </div>

      <LocationConsentDialog
        open={consentOpen}
        onAgree={() => {
          grantLocationConsent();
          setConsentOpen(false);
          locate();
        }}
        onDecline={() => {
          setConsentOpen(false);
          setGpsError('未开启定位：仍可直接保存，作为普通游玩笔记记录。');
        }}
      />

      <details className="group rounded-card border border-line">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2.5 text-copy font-bold [&::-webkit-details-marker]:hidden">
          补充花费、短评或照片（选填）
          <span className="text-meta font-normal text-muted">展开填写</span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <Field label="实际花了多少">
            <input
              id={`${fieldPrefix}-cost`}
              className={inputClass}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="例如 120 元（填总开销可算 AA）"
            />
          </Field>
          <div className="rounded-tile bg-canvas/80 p-3 text-xs" data-testid="checkin-aa-fields">
            <p className="font-bold text-ink-2">同行记账（选填，回顾页自动算 AA 转账）</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="谁付的钱">
              <span className="text-muted">付款人：</span>
              {travelers.map((person) => {
                const active = paidBy === person;
                return (
                  <button
                    key={`pay-${person}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPaidBy(person)}
                    className={cn(
                      'min-h-11 rounded-full border px-2.5 text-xs font-bold sm:min-h-8',
                      active ? 'border-ink bg-ink text-white' : 'border-line-strong bg-white text-ink-2'
                    )}
                  >
                    {person}
                  </button>
                );
              })}
            </div>
            {travelers.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="参与分摊的人">
                <span className="text-muted">参与分摊：</span>
                {travelers.map((person) => {
                  const active = splitWith.includes(person);
                  return (
                    <button
                      key={`split-${person}`}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setSplitWith((prev) => {
                          if (prev.includes(person)) {
                            const next = prev.filter((p) => p !== person);
                            return next.length ? next : [person];
                          }
                          return [...prev, person];
                        });
                      }}
                      className={cn(
                        'min-h-11 rounded-full border px-2.5 text-xs font-bold sm:min-h-8',
                        active ? 'border-primary-strong bg-primary-soft text-primary-strong' : 'border-line-strong bg-white text-muted'
                      )}
                    >
                      {active ? `${person} ✓` : person}
                    </button>
                  );
                })}
              </div>
            )}
            {onAddTraveler && (
              <div className="mt-2 flex items-center gap-1.5">
                <label className="sr-only" htmlFor={`${fieldPrefix}-add-traveler`}>
                  添加同行伙伴称呼
                </label>
                <input
                  id={`${fieldPrefix}-add-traveler`}
                  value={newTraveler}
                  onChange={(e) => setNewTraveler(e.target.value)}
                  placeholder="加同行人称呼，如 小林"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-white px-2.5 text-xs text-ink"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-white"
                  data-testid="checkin-add-traveler-btn"
                  disabled={!newTraveler.trim()}
                  onClick={() => {
                    const clean = newTraveler.trim().slice(0, 20);
                    if (!clean) return;
                    onAddTraveler(clean);
                    setSplitWith((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
                    setNewTraveler('');
                  }}
                >
                  <Plus /> 加同行人
                </Button>
              </div>
            )}
          </div>
          <Field label="排队时长补充">
            <input id={`${fieldPrefix}-queue`} className={inputClass} value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="例如 20 分钟" />
          </Field>
          <Field label="适合谁">
            <input
              id={`${fieldPrefix}-audience`}
              className={inputClass}
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="朋友 / 情侣 / 亲子 / 独行"
            />
          </Field>
          <Field label="一句话感受">
            <textarea
              id={`${fieldPrefix}-comment`}
              className={`${inputClass} min-h-20`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="现场怎么样、顺不顺路、值不值得留着…"
            />
          </Field>
          <Field label="避坑提醒">
            <input
              id={`${fieldPrefix}-pitfall`}
              className={inputClass}
              value={pitfall}
              onChange={(e) => setPitfall(e.target.value)}
              placeholder="关门、涨价、排长队、推销…"
            />
          </Field>
          <Field
            label="拍张照（选填）"
            hint={photoBusy ? '照片压缩中…' : photoData ? `已准备上传：${photoName || '打卡照片'}` : '会压缩后上传；没网时先存在手机里，联网自动补传。'}
          >
            <input id={`${fieldPrefix}-photo`} className={`${inputClass} py-2`} type="file" accept="image/*" onChange={handlePhotoChange} />
          </Field>
          {photoError && <p className="text-meta font-semibold text-lemon-ink">{photoError}</p>}
        </div>
      </details>
      <div className="sticky bottom-0 -mx-5 flex gap-3 border-t border-line bg-white px-5 pt-3 pb-1">
        <Button className="flex-1" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" className="flex-[2]" disabled={photoBusy}>
          <Check /> {photoBusy ? '照片处理中…' : '记录到达'}
        </Button>
      </div>
    </form>
  );
}

/** @param {Record<string, any>} props */
function ChoiceGroup({ label, options, value, onChange }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-bold text-ink-2">{label}（选填）</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            type="button"
            key={option}
            aria-pressed={value === option}
            onClick={() => onChange(value === option ? '' : option)}
            className={cn(
              'min-h-11 min-w-16 rounded-full px-4 text-copy font-semibold sm:min-h-10',
              value === option ? 'bg-ink text-white' : 'bg-canvas text-ink-2 hover:bg-line'
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

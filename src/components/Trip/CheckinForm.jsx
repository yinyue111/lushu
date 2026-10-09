import { useId, useState } from 'react';
import { Check, LocateFixed } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Field, inputClass } from '../ui/field';

// 本地暂存照片 dataURL 上限（约 400KB），防 localStorage 被撑爆。
const MAX_PHOTO_DATA_URL_LENGTH = 400 * 1024;

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
export default function CheckinForm({ onSubmit, onCancel }) {
  const fieldPrefix = useId().replaceAll(':', '');
  const [queue, setQueue] = useState('');
  const [cost, setCost] = useState('');
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

  function locate() {
    setGpsError('');
    if (!navigator.geolocation) {
      setGpsError('当前浏览器不支持 GPS，仍可记录到达；服务端会保存为普通反馈。');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setGps({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
          accuracy: Math.round(position.coords.accuracy),
          // 客户端无法可靠判定浏览器返回的坐标系，标注 unknown 交由服务端双算纠偏。
          coordinateSystem: 'unknown',
          userAgent: String(navigator.userAgent ?? '').slice(0, 160)
        }),
      () => setGpsError('定位失败，仍可记录到达；服务端会保存为普通反馈，不是已验证到达。'),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    setPhotoError('');
    setPhotoData('');
    setPhotoName(file?.name ?? '');
    if (!file) return;
    setPhotoBusy(true);
    try {
      // canvas 压缩到最长边 1280、JPEG 质量 0.8，控制上传与本地暂存体积。
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
        onSubmit({ queue, cost, worth, crowd, comment, pitfall, audience, photoName, photoData, gps });
      }}
    >
      <div className="rounded-card bg-canvas p-3.5">
        <Button variant={gps ? 'soft' : 'dark'} className="w-full" onClick={locate}>
          <LocateFixed /> {gps ? '重新定位' : '用 GPS 证明我到了（选填）'}
        </Button>
        <p className={cn('mt-2 text-meta', gpsError ? 'font-semibold text-lemon-ink' : 'text-muted')}>
          {gps ? `已定位 · 精度约 ${gps.accuracy} 米` : gpsError || '不开定位也能记录；只是这条会作为普通反馈，不算“到达验证”。'}
        </p>
      </div>
      <ChoiceGroup label="值不值得去" options={['值得', '一般', '踩坑']} value={worth} onChange={setWorth} />
      <ChoiceGroup label="现场人多吗" options={['空', '适中', '拥挤', '不建议']} value={crowd} onChange={setCrowd} />
      <details className="group rounded-card border border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-copy font-bold">
          多说几句（选填）
          <span className="text-meta font-normal text-muted">排队、花费、短评、照片</span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <Field label="排队多久">
            <input id={`${fieldPrefix}-queue`} className={inputClass} value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="例如 15 分钟" />
          </Field>
          <Field label="实际花了多少">
            <input id={`${fieldPrefix}-cost`} className={inputClass} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="例如 80 元" />
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
          <Field label="踩坑提醒">
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
              'h-10 min-w-16 rounded-full px-4 text-copy font-semibold',
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

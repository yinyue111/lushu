import { useState } from 'react';
import { CircleCheckBig, X } from 'lucide-react';

function etaText(seconds) {
  if (!seconds) return '一般要 2–8 分钟';
  if (seconds < 60) return '大约还要不到 1 分钟';
  return `大约还要 ${Math.round(seconds / 60)} 分钟`;
}

/** 补全进度和结果：在等什么、大概多久、查完不用刷新就提示。 */
export default function EnrichmentStatus({ enrichment }) {
  const [dismissed, setDismissed] = useState(false);
  const { status, progress, etaSeconds, justFinished, gaveUp } = enrichment;
  if (status === 'pending') {
    const total = progress?.stopsTotal || 0;
    const done = progress?.stopsDone || 0;
    const current = progress?.nextStop || '';
    return (
      <div role="status" className="mb-3 rounded-card bg-sky-soft px-3 py-2 text-meta text-sky-ink sm:text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <span className="size-2 rounded-full bg-sky motion-safe:animate-pulse" aria-hidden="true" />
          正在帮你查票价和开放时间
        </p>
        <p className="mt-0.5 pl-4">
          {gaveUp
            ? '这次比平时慢。查好会自动存进路书，稍后再打开就能看到。'
            : [
                total ? (progress?.queued && !done ? `排队中，共 ${total} 站` : `已查 ${done}/${total} 站`) : '',
                current && !progress?.queued ? `正在查「${current}」` : '',
                etaText(etaSeconds)
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
        {!gaveUp && <p className="pl-4 text-sky-ink/80">可以先离开，查好会存进路书。</p>}
      </div>
    );
  }
  if (dismissed || !justFinished) return null;
  if (status === 'failed') {
    return (
      <p role="status" className="mb-3 rounded-card bg-canvas px-3 py-2 text-meta text-ink-2 sm:text-sm">
        这次没查成功。标着「待确认」的地方，出发前请自己看一眼。
      </p>
    );
  }
  if (status !== 'done') return null;
  const found = progress?.filled ?? 0;
  const missing = progress?.notFound ?? 0;
  return (
    <div role="status" className="mb-3 flex items-start gap-2 rounded-card bg-success-soft px-3 py-2 text-meta text-success-ink sm:text-sm">
      <CircleCheckBig className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">查好了：</span>
        {found ? `${found} 处票价或开放时间找到了来源，已标在各站上` : '这次没找到能对得上的来源'}
        {missing ? `；${missing} 处没查到（连锁店没写分店、各网站说法不一等），仍是「待确认」` : ''}。
      </p>
      <button type="button" className="-m-1 p-1 text-success-ink" aria-label="关闭提示" onClick={() => setDismissed(true)}>
        <X className="size-4" />
      </button>
    </div>
  );
}

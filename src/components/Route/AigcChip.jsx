import { Sparkles } from 'lucide-react';
import { aigcMetadata } from '../../lib/aigc.js';
import { generationModeLabel } from '../../lib/generationModes.js';
import { cn } from '../ui/cn';

// 显式标识：AI 生成的路书在标题区常驻「AI 生成」标签。
export default function AigcChip({ routebook, className = '' }) {
  const meta = aigcMetadata(routebook);
  if (!meta.generated) return null;
  // The owner's copy records which mode made it (轻快 / 细品); public views carry no provider details.
  const modeLabel = generationModeLabel(routebook?.provider?.mode);
  const label = modeLabel ? `${meta.label} · ${modeLabel}` : meta.label;
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-bold text-white backdrop-blur', className)}
      data-aigc-label={meta.label}
      title={`内容由 AI 生成${modeLabel ? `（${modeLabel}模式${routebook?.provider?.model ? `，${routebook.provider.model}` : ''}）` : ''}，地点、时间与价格请以现场和官方信息为准`}
    >
      <Sparkles className="size-3.5" aria-hidden="true" /> {label}
    </span>
  );
}

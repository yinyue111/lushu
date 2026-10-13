import { Sparkles } from 'lucide-react';
import { aigcMetadata } from '../../lib/aigc.js';
import { generationModeLabel } from '../../lib/generationModes.js';
import { cn } from '../ui/cn';

// 显式标识：AI 生成的路书在标题区常驻「AI 生成」标签。
// 合并后的唯一标识：draft=试运行城市草稿，withImage=同一区域的示意配图也是 AI 生成。
export default function AigcChip({ routebook, className = '', draft = false, withImage = false }) {
  const meta = aigcMetadata(routebook);
  if (!meta.generated) return null;
  // The owner's copy records which mode made it (轻快 / 细品); public views carry no provider details.
  const modeLabel = generationModeLabel(routebook?.provider?.mode);
  const label = [meta.label + (draft ? '草稿' : ''), withImage ? '含配图' : ''].filter(Boolean).join(' · ');
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-bold text-white backdrop-blur', className)}
      data-aigc-label={meta.label}
      title={`${withImage ? '文字与配图' : '内容'}由 AI 生成${modeLabel ? `（${modeLabel}模式${routebook?.provider?.model ? `，${routebook.provider.model}` : ''}）` : ''}，${draft ? '这座城市还没人工核对，' : ''}地点、时间与价格请以现场和官方信息为准`}
    >
      <Sparkles className="size-3.5" aria-hidden="true" /> {label}
    </span>
  );
}

import { ShieldCheck, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { getRouteTrustBadgeState } from '../../lib/trust';
import { Chip } from '../ui/chip';

/** Route trust badge in B styling; state always comes from lib/trust (single source). */
/** @param {Record<string, any>} props */
export function TrustChip({ routebook, size = 'sm', className = '', curated = false }) {
  const state = getRouteTrustBadgeState(routebook);
  if (state.tone === 'trial') {
    return (
      <Chip tone="warn" size={size} className={className}>
        <TriangleAlert /> AI 草稿 · 未实地确认
      </Chip>
    );
  }
  if (state.verified) {
    return (
      <Chip tone="ok" size={size} className={className}>
        <ShieldCheck /> 可信分 {state.score}
      </Chip>
    );
  }
  return (
    <Chip tone="sky" size={size} className={className}>
      <ShieldQuestion /> {curated ? '编辑推荐 · 还没人走过' : '还没人走过'}
    </Chip>
  );
}

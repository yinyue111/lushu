import { Loader2, RefreshCw } from 'lucide-react';
import { roadSummary } from '../../lib/routeRoads';
import { Button } from '../ui/button';

/**
 * Owner draft only: road verification status plus a self-service "重新核验道路" button
 * (re-locates stops whose position is unconfirmed, re-verifies touched legs; rate-limited server-side).
 * @param {{ routebook: Record<string, any>, recheckState: { busy: boolean, message: string }, onRecheck: () => void }} props
 */
export default function RecheckBar({ routebook, recheckState, onRecheck }) {
  const stops = routebook.stops ?? [];
  const road = roadSummary(stops, routebook.routeLegs ?? []);
  const pending = stops.filter((stop) => stop.navigationDisabled === true || stop.coordinateSource === 'user-edit').length;
  return (
    <section
      aria-label="道路核验"
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tile border border-line bg-canvas px-3.5 py-2.5 text-sm"
      data-testid="recheck-bar"
    >
      <span className="min-w-0 flex-1 font-semibold text-ink-2">
        {road.expectedLegs ? `道路 ${road.verifiedLegs}/${road.expectedLegs} 段已核验` : '暂无需要核验的道路'}
        {pending > 0 && ` · ${pending} 个站点位置待确认`}
      </span>
      <Button size="sm" variant="outline" onClick={onRecheck} disabled={recheckState.busy} aria-describedby="recheck-status">
        {recheckState.busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        {recheckState.busy ? '正在查路线…' : '重新查路线'}
      </Button>
      <p id="recheck-status" role="status" aria-live="polite" className="w-full text-xs font-semibold text-ink-2 empty:hidden">
        {recheckState.message}
      </p>
    </section>
  );
}

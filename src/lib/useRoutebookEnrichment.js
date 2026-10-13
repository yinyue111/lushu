import { useCallback, useEffect, useState } from 'react';
import { getRoutebookEnrichment, reportRoutebookEnrichment } from './api';

import { POLL_START_MS, POLL_TOTAL_MS, estimateRemainingSeconds, nextPollDelay } from './enrichmentPoll';

/**
 * Background-checked 门票 / 开放时间 for a saved routebook. Polls while the check is running.
 * @param {any} routebook
 */
export function useRoutebookEnrichment(routebook) {
  const routeId = routebook?.publicId || routebook?.id || '';
  const editToken = routebook?.editToken || '';
  const saved = Boolean(routeId && (routebook?.version || routebook?.savedAt || routebook?.provider?.savedAt));
  const [state, setState] = useState(
    /** @type {{ status: string, claims: any[], progress: any, etaSeconds?: number | null, justFinished?: boolean, gaveUp?: boolean }} */ ({
      status: 'none',
      claims: [],
      progress: null
    })
  );

  useEffect(() => {
    if (!saved) {
      setState({ status: 'none', claims: [], progress: null });
      return undefined;
    }
    const controller = new AbortController();
    let timer;
    let delay = POLL_START_MS;
    const startedAt = Date.now();
    const samples = [];
    let sawPending = false;
    const load = async () => {
      clearTimeout(timer);
      try {
        const data = await getRoutebookEnrichment(routeId, controller.signal, { editToken });
        const next = data?.enrichment ?? { status: 'none', claims: [], progress: null };
        if (next.status === 'pending') {
          sawPending = true;
          samples.push({ at: Date.now(), done: Number(next.progress?.stopsDone) || 0 });
          if (samples.length > 12) samples.shift();
        }
        const gaveUp = next.status === 'pending' && Date.now() - startedAt > POLL_TOTAL_MS;
        setState({
          ...next,
          etaSeconds: next.status === 'pending' ? estimateRemainingSeconds(samples, next.progress) : null,
          // 只在本页看着它从「核对中」变成完成时提示一次「查好了」，免得每次打开都弹。
          justFinished: sawPending && next.status !== 'pending',
          gaveUp
        });
        if (next.status === 'pending' && !gaveUp && !document.hidden) {
          timer = setTimeout(load, delay);
          delay = nextPollDelay(delay);
        }
      } catch {
        // Not available (guest routebook, old server, offline): show nothing.
      }
    };
    const onVisible = () => {
      if (!document.hidden && sawPending) {
        delay = POLL_START_MS;
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [routeId, editToken, saved]);

  const claimsFor = useCallback(
    (stop) => (stop?.id == null ? [] : state.claims.filter((c) => c.stopKey === String(stop.id) && c.stopName === String(stop.name ?? '').trim())),
    [state.claims]
  );

  const report = useCallback(
    async (claim, note = '') => {
      const response = await reportRoutebookEnrichment(routeId, { stopKey: claim.stopKey, field: claim.field, note, editToken });
      // The value stays visible, marked 「已反馈待复核」, until an operator reviews it.
      setState((prev) => ({
        ...prev,
        claims: prev.claims.map((c) => (c.stopKey === claim.stopKey && c.field === claim.field ? { ...c, reported: true } : c))
      }));
      return response;
    },
    [routeId, editToken]
  );

  return {
    status: state.status,
    claims: state.claims,
    progress: state.progress ?? null,
    etaSeconds: state.etaSeconds ?? null,
    justFinished: Boolean(state.justFinished),
    gaveUp: Boolean(state.gaveUp),
    claimsFor,
    report
  };
}

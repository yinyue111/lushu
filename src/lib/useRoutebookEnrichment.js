import { useCallback, useEffect, useState } from 'react';
import { getRoutebookEnrichment, reportRoutebookEnrichment } from './api';

const POLL_MS = 5000;
const MAX_POLLS = 60; // about 5 minutes; reopening the routebook checks again

/**
 * Background-checked 门票 / 开放时间 for a saved routebook. Polls while the check is running.
 * @param {any} routebook
 */
export function useRoutebookEnrichment(routebook) {
  const routeId = routebook?.publicId || routebook?.id || '';
  const editToken = routebook?.editToken || '';
  const saved = Boolean(routeId && (routebook?.version || routebook?.savedAt || routebook?.provider?.savedAt));
  const [state, setState] = useState({ status: 'none', claims: [] });

  useEffect(() => {
    if (!saved) {
      setState({ status: 'none', claims: [] });
      return undefined;
    }
    const controller = new AbortController();
    let timer;
    let polls = 0;
    const load = async () => {
      try {
        const data = await getRoutebookEnrichment(routeId, controller.signal, { editToken });
        const next = data?.enrichment ?? { status: 'none', claims: [] };
        setState(next);
        polls += 1;
        if (next.status === 'pending' && polls < MAX_POLLS) timer = setTimeout(load, POLL_MS);
      } catch {
        // Not available (guest routebook, old server, offline): show nothing.
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [routeId, editToken, saved]);

  const claimsFor = useCallback(
    (stop) => (stop?.id == null ? [] : state.claims.filter((c) => c.stopKey === String(stop.id) && c.stopName === String(stop.name ?? '').trim())),
    [state.claims]
  );

  const report = useCallback(
    async (claim, note = '') => {
      await reportRoutebookEnrichment(routeId, { stopKey: claim.stopKey, field: claim.field, note, editToken });
      setState((prev) => ({ ...prev, claims: prev.claims.filter((c) => !(c.stopKey === claim.stopKey && c.field === claim.field)) }));
    },
    [routeId, editToken]
  );

  return { status: state.status, claims: state.claims, claimsFor, report };
}

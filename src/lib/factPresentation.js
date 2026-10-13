/**
 * What the summary line shows. A value with an open user report carries only 「已反馈待复核」: the
 * 「人工核实 / 已核对」 marks are dropped and a note says truthfully where the shown value came from.
 */
export function factPresentation(claim) {
  const n = claim?.sources?.length ?? 0;
  const ops = claim?.method === 'ops-verified';
  const raw = String(claim?.display ?? '');
  if (!claim?.reported) {
    return { label: ops ? '人工核实' : '已核对', display: raw, reviewNote: '' };
  }
  const reviewNote = ops
    ? '当前显示的是上次人工核实的值'
    : n >= 2
      ? `当前显示的是自动核对的值（${n} 个来源一致）`
      : '当前显示的是自动查到的值（只有 1 个来源）';
  return { label: '', display: raw.replace(/ · 人工核实(?= · |$)/, ''), reviewNote };
}

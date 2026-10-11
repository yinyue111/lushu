/**
 * Once a field is checked, the original 「…待确认」 wording for it is not shown any more
 * (the routebook itself is unchanged, so a "wrong" report brings it back).
 * @param {string} text
 * @param {{ price?: boolean, hours?: boolean }} checked
 */
export function withoutCheckedPending(text, checked) {
  let out = String(text ?? '');
  if (checked.hours) out = out.replace(/[（(]?\s*(?:开放|营业)时间(?:需|请)?待确认\s*[）)]?/g, '');
  if (checked.price) out = out.replace(/[（(]?\s*(?:门票|票价|价格)(?:需|请)?待确认\s*[）)]?/g, '');
  return out
    .replace(/^[\s，,、；;。]+|[\s，,、；;]+$/g, '')
    .replace(/([，,、；;])\s*[，,、；;]+/g, '$1')
    .trim();
}

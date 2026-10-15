// §2.1: stored routebooks written before the terminology pass still carry 「待验证 / 最近验证 / 未核验」.
// Public read paths run user-visible metric/validation strings through this so old data reads the same
// as new data. Only exact legacy phrases are rewritten; v4 state names (核对中/已核对/已反馈待复核/
// 人工核实/待确认) are untouched.
const LEGACY = [
  ['POI 待验证', '地点待核对'],
  ['待验证', '待核对'],
  ['最近验证', '最近核对'],
  ['未核验', '未核对'],
  ['资料核验分', '资料核对分']
];

export function modernTermCopy(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const [from, to] of LEGACY) out = out.split(from).join(to);
  return out;
}

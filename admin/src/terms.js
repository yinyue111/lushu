// One place for the Chinese words the console shows for internal status values, shared with the user side:
// 「核对中」「已核对」「已反馈待复核」「人工核实」「待确认」. Unknown values fall back to the raw value.
export const MODE = { fast: '轻快', deep: '细品' };
export const ENRICH_JOB = { queued: '排队中', running: '核对中', done: '已查完', failed: '失败', skipped: '跳过' };
export const CLAIM = { filled: '已核对', reported: '已反馈待复核', disputed: '待确认（已改回）', kept: '待确认' };
export const METHOD = {
  pages: '网页核对（多来源）',
  'single-page': '网页核对（单来源）',
  'amap+page': '高德 + 网页核对',
  'ops-verified': '人工核实'
};
export const GENERATION = { ok: '成功', error: '失败', cancelled: '已取消' };
export const term = (map, value) => (value == null || value === '' ? '—' : (map[value] ?? value));
/** Build info that was not injected at build time. */
export const injected = (value) => (value == null || value === '' || value === 'unknown' ? '未注入' : value);

export const ACTION_LABEL = {
  'totp.bind': '绑定动态码',
  'admin.create': '新建后台账号',
  'admin.disable': '停用后台账号',
  'admin.enable': '启用后台账号',
  'admin.reset-totp': '重置动态码',
  'admin.set-role': '改后台角色',
  'user.ban': '封禁用户',
  'user.unban': '解封用户',
  'user.set-quota': '改用户额度',
  'user.reset-quota': '清零用户次数',
  'user.send-recovery': '发恢复码',
  'config.save': '保存配置',
  'config.restore': '恢复配置版本',
  'roadbook.take-down': '下架分享链接',
  'roadbook.rerun-enrichment': '重跑联网核对',
  'correction.verify': '设为人工核实',
  'correction.reset': '改回待确认',
  'correction.reject': '驳回报错',
  'correction.rerun': '重跑联网核对'
};
export const actionLabel = (action) => ACTION_LABEL[action] || action;

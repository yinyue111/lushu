// 隐私说明里和代码事实绑定的文案。改第三方类别前先核对代码：
// - 邮件：server/mail/transport.mjs 通过 resend（HTTP API）或 SMTP 发信。
// - AI 模型：生成路书与截图识别调用配置的大模型服务。
// - 短信：没有接入（手机号不发短信），不列。
// - 内容安全：默认只有本地关键词预过滤，domestic 适配器是未接厂商的桩（server/moderation/providers.mjs），不列。
export const THIRD_PARTY_CATEGORIES = ['邮件', 'AI 模型'];

export function thirdPartySentence(categories = THIRD_PARTY_CATEGORIES) {
  const last = categories[categories.length - 1];
  // 中文与英文/数字之间留一个空格（「和 AI 模型」）。
  const list = categories.length > 1 ? `${categories.slice(0, -1).join('、')}和${/^[A-Za-z0-9]/.test(last) ? ' ' : ''}${last}` : last;
  return `我们会使用第三方的${list}服务来提供功能，只传给它们完成这项功能所需的信息。`;
}

/** @param {{ name?: string, email?: string } | null | undefined} operator */
export function operatorCopy(operator) {
  const name = String(operator?.name ?? '').trim();
  const email = String(operator?.email ?? '').trim();
  return {
    operatorLine: name ? `运营主体：${name}${email ? `，联系邮箱 ${email}` : ''}。` : '',
    supportLine: email ? `发邮件到 ${email}，7 个工作日内回复。` : ''
  };
}

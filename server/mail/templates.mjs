// Account mails. Plain text, short, no links: codes are typed into the page, so a phishing copy of
// this mail has nothing to click.
const SIGN = '\n\n—— 路书\n这封邮件由系统发出，不用回复。';

export function codeMail(purpose, code) {
  const what = { register: '注册账号', reset: '重设密码', change: '绑定这个邮箱' }[purpose] ?? '验证邮箱';
  return {
    kind: `code-${purpose}`,
    subject: `路书验证码 ${code}`,
    text: `你正在${what}，验证码是：\n\n    ${code}\n\n15 分钟内有效，只能用一次。别把它告诉任何人，我们不会向你索要验证码。\n如果不是你本人操作，忽略这封邮件就好，你的账号不会有变化。${SIGN}`
  };
}

export function alreadyRegisteredMail() {
  return {
    kind: 'already-registered',
    subject: '有人用你的邮箱注册路书',
    text: `刚才有人用这个邮箱注册路书，但这个邮箱已经有账号了。\n如果是你，直接登录就行；忘了密码，可以在登录页点「忘了密码」用邮箱重设。\n如果不是你，忽略这封邮件，你的账号不会有变化。${SIGN}`
  };
}

export function passwordChangedMail() {
  return {
    kind: 'password-reset',
    subject: '你的路书密码已重设',
    text: `你的路书账号刚刚重设了密码，所有设备上的登录都已退出。\n如果不是你本人操作，请马上用邮箱验证码或恢复码再重设一次密码，并联系我们。${SIGN}`
  };
}

export function emailChangedMail(newMasked) {
  return {
    kind: 'email-changed',
    subject: '你的路书账号邮箱已更换',
    text: `你的路书账号邮箱已改为 ${newMasked}，以后验证码会发到新邮箱。\n如果不是你本人操作，请用恢复码重设密码，并联系我们。${SIGN}`
  };
}

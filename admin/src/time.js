/** HH:mm in Asia/Taipei (UTC+8, same clock as the team's day). @param {string} iso */
export const hhmmTaipei = (iso) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

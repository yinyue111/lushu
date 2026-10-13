// "离线查看，信息更新于<time>": shown on the roadbook page while the browser is offline, so a traveller knows
// the hours/prices on screen are as of the last sync, not live. Time is the newest of the routebook's own
// timestamps (edit / save / generation), shown in Beijing time. No timestamp → no time claimed.
export function routebookUpdatedAt(routebook) {
  const ms = Math.max(
    0,
    ...[routebook?.provider?.editedAt, routebook?.updatedAt, routebook?.provider?.generatedAt, routebook?.createdAt].map(
      (value) => Date.parse(value ?? '') || 0
    )
  );
  return ms > 0 ? new Date(ms) : null;
}

export function formatBeijingTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

export function offlineBannerText(routebook) {
  const at = routebookUpdatedAt(routebook);
  return at ? `离线查看，信息更新于${formatBeijingTime(at)}` : '离线查看，信息更新时间未知';
}

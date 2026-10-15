// 行中计划云同步失败时给用户的说明。ROUTEBOOK_NOT_FOUND 最常见的原因是这份路书只存在本机
// （例如在未开启云同步时“保存副本并出发”），不能说成“路书不存在或已删除”吓到用户。
export function tripSyncErrorMessage(error) {
  if (error?.code === 'ROUTEBOOK_NOT_FOUND') {
    return '这份路书还只保存在本机，行中计划和打卡都已在本机保留；回到路书页点「保存路书」上传后，就能跨设备继续';
  }
  // Network failures retry on the browser 'online' event (useTripCloudSync), so 「联网后会自动同步」 is true there only.
  if (error?.code === 'NETWORK_OFFLINE' || error instanceof TypeError) return '行中计划先存在这台设备上了，联网后会自动同步。';
  return '行中计划先存在这台设备上了，云端这次没同步上。';
}

export const ROUTEBOOK_ROUTING_UNVERIFIED = 'ROUTEBOOK_ROUTING_UNVERIFIED';

export async function submitRoutebookStatusWithRoutingGate({
  publicId,
  payload,
  routebookTitle,
  request,
  confirmOverride = (message) => window.confirm(message),
  promptReason = (message) => window.prompt(message)
}) {
  try {
    return { data: await request(publicId, payload), overridden: false, cancelled: false };
  } catch (error) {
    if (error?.code !== ROUTEBOOK_ROUTING_UNVERIFIED) throw error;

    const confirmed = confirmOverride(`${error.message}\n\n确认要对“${routebookTitle || '这条路书'}”发起例外发布吗？此操作会进入版本审计。`);
    if (!confirmed) return { data: null, overridden: false, cancelled: true };

    const rawReason = promptReason('请填写例外发布原因（至少 8 个字符，会进入审计记录）');
    if (rawReason == null) return { data: null, overridden: false, cancelled: true };
    const routingOverrideReason = String(rawReason).trim();
    if (routingOverrideReason.length < 8) {
      const validationError = /** @type {Error & {code?: string}} */ (new Error('例外发布原因至少需要 8 个字符'));
      validationError.code = 'ROUTEBOOK_ROUTING_OVERRIDE_REASON_REQUIRED';
      throw validationError;
    }

    return {
      data: await request(publicId, {
        ...payload,
        allowUnverifiedRouting: true,
        routingOverrideReason
      }),
      overridden: true,
      cancelled: false
    };
  }
}

// AI-generated content labelling: one rule for the visible label and the implicit
// (metadata) label, derived at read time from what the routebook records about itself,
// so routebooks saved before this change are labelled too.
export const AIGC_LABEL_VERSION = 1;
export const AIGC_PRODUCER = '可信路书';

/** @param {any} routebook */
export function isAiGeneratedRoutebook(routebook) {
  // Public views carry the server-derived label because they omit provider details.
  if (typeof routebook?.aigc?.generated === 'boolean') return routebook.aigc.generated;
  const provider = routebook?.provider ?? {};
  if (provider.generatedAt || provider.model) return true;
  return (Array.isArray(routebook?.stops) ? routebook.stops : []).some((stop) => stop?.provenance?.origin === 'model');
}

/** @param {any} routebook */
export function aigcMetadata(routebook) {
  if (!isAiGeneratedRoutebook(routebook)) return { generated: false, labelVersion: AIGC_LABEL_VERSION };
  if (routebook?.aigc?.generated === true && !routebook?.provider) return { ...routebook.aigc };
  const edited = Boolean(routebook?.provider?.editedAt);
  return {
    generated: true,
    label: edited ? 'AI 生成 · 经用户编辑' : 'AI 生成',
    producer: AIGC_PRODUCER,
    contentId: String(routebook?.publicId || routebook?.id || ''),
    generatedAt: String(routebook?.provider?.generatedAt || ''),
    labelVersion: AIGC_LABEL_VERSION
  };
}

// Shared (server + client) view of where a routebook's guide came from. Routebooks built
// from imported third-party guides follow a stricter publishing policy (原作者授权).

export const GUIDE_ORIGINS = ['link', 'ocr'];

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeGuideOrigins(value) {
  const list = Array.isArray(value) ? value : [];
  return GUIDE_ORIGINS.filter((origin) => list.includes(origin));
}

/**
 * @param {{ guideOrigins?: unknown, importedSources?: unknown[] } | null | undefined} routebook
 * @returns {string[]}
 */
export function routebookGuideOrigins(routebook) {
  const origins = new Set(normalizeGuideOrigins(routebook?.guideOrigins));
  if (Array.isArray(routebook?.importedSources) && routebook.importedSources.length) origins.add('link');
  return GUIDE_ORIGINS.filter((origin) => origins.has(origin));
}

/** @param {Parameters<typeof routebookGuideOrigins>[0]} routebook */
export function isImportedRoutebook(routebook) {
  return routebookGuideOrigins(routebook).length > 0;
}

export const IMPORTED_PUBLIC_EXPLANATION =
  '这条路书是根据导入的第三方攻略（小红书、抖音、X、网页链接或截图）生成的。攻略内容属于原作者，没有原作者授权前不能公开发布到列表和搜索里；你可以自己用，或生成朋友链接只发给朋友。';

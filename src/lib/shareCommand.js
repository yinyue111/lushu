/**
 * Share-command (分享口令) URL extraction and boilerplate stripping for
 * Xiaohongshu, Douyin, Bilibili, Dianping, Weibo, and standard web links.
 * Kept pure and dependency-free so both Builder and server import share one implementation.
 */

const ASCII_URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;

function trimBalancedUrlTail(rawUrl) {
  let url = String(rawUrl ?? '').trim();
  while (url.length > 8) {
    const last = url[url.length - 1];
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    if (last === ']' && (url.match(/\[/g)?.length ?? 0) >= (url.match(/\]/g)?.length ?? 0)) break;
    if (/[.,;:!?)'"\]]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/**
 * Extract clean RFC-3986 HTTP(S) URLs without swallowing glued CJK text or full-width brackets
 * (e.g. `http://xhslink.com/a/abc【小红书】` or `https://v.douyin.com/xyz/复制此链接`).
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function extractCleanUrls(text, limit = 12) {
  const matches = String(text ?? '').match(ASCII_URL_RE) ?? [];
  const cleaned = matches.map(trimBalancedUrlTail).filter((url) => /^https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/i.test(url));
  return [...new Set(cleaned)].slice(0, limit);
}

/**
 * Detect whether text contains app share-command wrapper noise.
 * @param {string} text
 * @returns {boolean}
 */
export function hasShareCommandWrapper(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  return (
    /发布了一篇小红书笔记|复制(?:本条信息|此链接|后|这段话).{0,18}打开|长按复制此条消息|复制打开抖音|打开【?(?:小红书|抖音|大众点评|哔哩哔哩)】?(?:App|APP|搜索)?/iu.test(
      value
    ) ||
    /(?:^|\n)\s*\d+\.\d+\s+[A-Za-z0-9@/:._-]{2,14}\s+/m.test(value) ||
    /[\u{1F300}-\u{1FAFF}]\s*[A-Za-z0-9_-]{5,24}\s*[\u{1F300}-\u{1FAFF}]/u.test(value)
  );
}

/**
 * Strip app share-command wrappers while keeping meaningful note titles and user prose.
 * @param {string} text
 * @param {{ keepUrls?: boolean }} [options]
 * @returns {string}
 */
export function stripShareCommandBoilerplate(text, { keepUrls = false } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const urls = keepUrls ? extractCleanUrls(raw, 20) : [];

  let cleaned = raw
    // Strip URLs first so surrounding wrapper tokens collapse cleanly.
    .replace(ASCII_URL_RE, ' ')
    // Xiaohongshu lead-in: "72 小王发布了一篇小红书笔记，快来看吧！"
    .replace(/(?:^|\n)\s*\d{1,3}\s+[^\n，,！!]{1,28}发布了一篇小红书笔记[，,。\s]*(?:快来看吧[！!。.\s]*)?/gu, '\n')
    //Xiaohongshu standalone numeric lead-in before title bracket: "45 【杭州攻略...】"
    .replace(/(?:^|\n)\s*\d{1,3}\s+(?=【)/gu, '\n')
    // Douyin numeric + cipher prefix: "4.89 u@s.Rk 08/24 MwS:/ "
    .replace(/(?:^|\n)\s*\d+\.\d+\s+(?:[A-Za-z0-9@/:._-]{1,16}\s+){0,5}/gu, '\n')
    // Emoji token wrappers: "😆 fJk89LmN0pQ 😆"
    .replace(/[\u{1F300}-\u{1FAFF}]\s*[A-Za-z0-9_-]{4,24}\s*[\u{1F300}-\u{1FAFF}]/gu, ' ')
    // Douyin lead-in: "复制打开抖音，看看【阿泽旅行的作品】"
    .replace(/复制打开抖音[，,\s]*(?:看看)?/gu, ' ')
    .replace(/【[^】]{1,24}的作品】/gu, ' ')
    // Platform CTA tails
    .replace(
      /[，,。.\s]*复制(?:本条信息|此链接|后|这段话)?[，,\s]*打开(?:【?(?:小红书|抖音|Douyin|大众点评|哔哩哔哩|B站|微博)】?)?(?:App|APP|搜索)?[，,\s]*(?:查看(?:精彩内容|笔记|详情|全文|TA的更多作品)|直接观看视频)?[！!。.\s]*/giu,
      ' '
    )
    .replace(/[，,。.\s]*长按复制此条消息[，,\s]*打开(?:抖音|小红书|大众点评)[^\n。！!]*[。！!]?/gu, ' ')
    // Unwrap brackets: drop pure platform names, clean suffix inside note title brackets
    .replace(/【([^】]{1,100})】/gu, (_, inner) => {
      const trimmed = String(inner)
        .replace(/\s*(?:\||｜|-|—)\s*(?:小红书|抖音|大众点评|哔哩哔哩).*$/iu, '')
        .trim();
      if (!trimmed || /^(?:小红书|抖音|Douyin|大众点评|哔哩哔哩|B站|微博|话题)$/iu.test(trimmed)) return ' ';
      return ` ${trimmed} `;
    })
    // Clean dangling punctuation left after stripping
    .replace(/^[，,。；;、\s]+|[，,；;、\s]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (keepUrls && urls.length) {
    const urlBlock = urls.join('\n');
    return cleaned ? `${cleaned}\n${urlBlock}` : urlBlock;
  }
  return cleaned;
}

/**
 * Clean pasted share commands in the guide editor while preserving clean URLs and titles.
 * @param {string} text
 * @returns {string}
 */
export function cleanShareCommandForEditor(text) {
  return stripShareCommandBoilerplate(text, { keepUrls: true });
}

/**
 * Determine whether Step 1 has enough real guide content, candidates, or OCR places to generate,
 * rejecting empty/blocked share-command wrappers.
 */
export function hasActionableGuideInput({ guide = '', sources = [], candidates = [], ocrPlaces = [] } = {}) {
  if (Array.isArray(candidates) && candidates.some((place) => place.included)) return true;
  if (Array.isArray(ocrPlaces) && ocrPlaces.length > 0) return true;
  if (
    Array.isArray(sources) &&
    sources.some((source) => {
      if (source?.status !== 'fetched') return false;
      return [source.description, source.excerpt, source.content, source.guideText].some((value) => String(value ?? '').trim().length >= 20);
    })
  ) {
    return true;
  }
  const stripped = stripShareCommandBoilerplate(
    String(guide ?? '')
      .split(/\r?\n/)
      .filter((line) => {
        const value = line.trim();
        return value && !/^(?:来源\s*\d+\s*[｜|:：]|(?:标题|摘要|公开正文摘录|可信信号|风险提示|链接)[:：])/.test(value) && !/^已上传截图[:：]/.test(value);
      })
      .join('\n')
      .replace(/截图暂未识别成功[^\n。]*[。]?/g, '')
  );
  return stripped.length >= 8;
}

// Generation modes shown in the builder. The server decides the model and time budget per mode
// (AI_MODEL_FAST / AI_MODEL_DEEP …); the client only names them and remembers the last choice.
export const GENERATION_MODES = [
  { key: 'fast', label: '轻快', time: '大约半分钟', hint: '先快速出一版，看看思路，之后再慢慢改。' },
  { key: 'deep', label: '细品', time: '大约 2–3 分钟', hint: '排得更细：顺路、时间和取舍都会多想一想，要多等一会儿。' }
];
export const DEFAULT_GENERATION_MODE = 'fast';
const STORAGE_KEY = 'lushu:generation-mode';

/** @param {unknown} key */
export function generationModeLabel(key) {
  return GENERATION_MODES.find((mode) => mode.key === key)?.label ?? '';
}

export function readGenerationMode() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'fast' || value === 'deep' ? value : DEFAULT_GENERATION_MODE;
  } catch {
    return DEFAULT_GENERATION_MODE;
  }
}

/** @param {string} mode */
export function rememberGenerationMode(mode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

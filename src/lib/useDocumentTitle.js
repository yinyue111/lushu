import { useEffect } from 'react';

/** 「<路书标题>｜AI 可信路书」 while mounted (matches the server-rendered title); restores the previous title on leave. */
export function roadbookDocumentTitle(title) {
  const clean = String(title ?? '').trim();
  return clean ? `${clean.slice(0, 80)}｜AI 可信路书` : '';
}

export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title || typeof document === 'undefined') return undefined;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

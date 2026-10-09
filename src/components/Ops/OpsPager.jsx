import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Cursor pager for server-paged ops listings (F17).
 * @param {{ page: number, count: number, total?: number|null, canPrevious: boolean, canNext: boolean, busy?: boolean, onPrevious: () => void, onNext: () => void }} props
 */
export default function OpsPager({ page, count, total = null, canPrevious, canNext, busy = false, onPrevious, onNext }) {
  return (
    <div className="ops-inline-actions mt-3 justify-between">
      <span className="text-caption">
        第 {page} 页 · 当前 {count} 条{Number.isFinite(Number(total)) && total != null ? ` / 共 ${total} 条` : ''}
      </span>
      <div className="ops-inline-actions">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onPrevious} disabled={!canPrevious || busy}>
          <ChevronLeft size={13} /> 上一页
        </button>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onNext} disabled={!canNext || busy}>
          下一页 <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

/** Small cursor-stack state helper shared by paged panels. */
export function nextCursorStack(stack, nextCursor) {
  return nextCursor ? [...stack, nextCursor] : stack;
}

export function previousCursorStack(stack) {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

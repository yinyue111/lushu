import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { LoaderCircle, MapPin, Replace } from 'lucide-react';

/** Swap a stop via place search (AMap / catalog). */
export default function ReplaceStopDialog({ stop, city, onSearch, onPick, onClose }) {
  const [query, setQuery] = useState(stop?.name || '');
  const [pois, setPois] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!query.trim()) return;
      setBusy(true);
      const hits = await onSearch(query.trim());
      if (!cancelled) {
        setPois(hits);
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, onSearch]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`换掉「${stop?.name || '这一站'}」`} description={`在${city}搜一个地方，选中就替换，前后路线会自动重新查。`}>
        <Field label="搜地点或店名">
          <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="比如：锦里、某某茶馆" autoFocus />
        </Field>
        <div className="mt-3 max-h-72 space-y-2 overflow-auto">
          {busy && (
            <p className="flex items-center gap-2 text-meta text-muted">
              <LoaderCircle className="size-4 animate-spin" /> 搜索中…
            </p>
          )}
          {!busy && !pois.length && (
            <p className="text-meta text-muted">
              {pois.searchFailed ? '地图搜索暂时不可用，' : `在${city}没搜到这个地方。`}换个词试试，或者关掉后用「编辑信息」手动填。
            </p>
          )}
          {pois.map((poi) => (
            <button
              key={poi.id || poi.name}
              type="button"
              className="flex w-full items-start gap-2 rounded-tile border border-line bg-canvas px-3 py-2.5 text-left hover:border-primary"
              onClick={() => onPick(poi)}
            >
              <MapPin className="mt-0.5 size-4 shrink-0 text-primary-strong" />
              <span className="min-w-0">
                <b className="block text-copy">{poi.name}</b>
                <span className="text-meta text-muted">{poi.address || city}</span>
              </span>
              <Replace className="ml-auto size-4 shrink-0 text-muted" />
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

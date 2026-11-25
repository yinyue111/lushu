import { useMemo } from 'react';
import { Download, Printer, X } from 'lucide-react';
import { costDisplay } from '../../lib/cost';
import { buildPrintableItineraryHtml, buildQrSvgMarkup, stopNavigationUrl } from '../../lib/printItinerary';
import { trackEvent } from '../../lib/betaTelemetry.js';
import { formatStayText } from '../../lib/routeMeta';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';

/** @param {{ routebook: any, onClose: () => void }} props */
export default function PrintItineraryDialog({ routebook, onClose }) {
  const stops = useMemo(() => (Array.isArray(routebook?.stops) ? routebook.stops : []), [routebook?.stops]);
  const days = useMemo(
    () => (Array.isArray(routebook?.days) && routebook.days.length ? routebook.days : [...new Set(stops.map((s) => s.day || 'Day 1'))]),
    [routebook?.days, stops]
  );
  const htmlDoc = useMemo(() => buildPrintableItineraryHtml(routebook), [routebook]);

  function triggerPrint() {
    trackEvent('itinerary_print', 'print');
    const iframe = document.createElement('iframe');
    iframe.title = '打印行程单画布';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const cleanup = () => {
      window.setTimeout(() => {
        iframe.remove();
      }, 1500);
    };
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        cleanup();
      }
    };
    iframe.srcdoc = htmlDoc;
  }

  function downloadHtmlSheet() {
    const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${routebook?.city || '旅行'}-${routebook?.title || '随身行程单'}-打印版.html`.replace(/[\\/:*?"<>|]+/g, '-');
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="打印 / 存为 PDF 行程单"
        description="按天分页的大字版 A4 行程单，每站自带高德扫码导航，方便带父母出行或离线打印。"
        className="max-w-2xl overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
          <div>
            <h2 className="text-lg font-extrabold text-ink">A4 随身打印行程单</h2>
            <p className="text-xs text-muted">在系统打印窗口选择「另存为 PDF」即可导出高清 PDF 文件</p>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label="关闭">
              <X />
            </Button>
          </DialogClose>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={triggerPrint} data-testid="print-itinerary-now-btn">
            <Printer /> 立即打印 / 存为 PDF
          </Button>
          <Button variant="outline" onClick={downloadHtmlSheet} data-testid="download-itinerary-html-btn">
            <Download /> 下载离线网页版
          </Button>
        </div>

        <div
          tabIndex={0}
          role="region"
          aria-label="打印行程单预览"
          data-testid="print-itinerary-preview"
          className="mt-4 max-h-96 space-y-4 overflow-y-auto rounded-card border border-line bg-canvas p-4 focus-visible:outline-2 focus-visible:outline-sky"
        >
          {days.map((day) => {
            const dayStops = stops.filter((s) => (s.day || 'Day 1') === day);
            if (!dayStops.length) return null;
            return (
              <section key={day} className="rounded-xl border border-line bg-white p-4 shadow-card">
                <div className="flex items-center justify-between border-b border-ink pb-2">
                  <strong className="text-base font-extrabold text-ink">
                    {routebook?.city} · {day}
                  </strong>
                  <span className="rounded-full border border-ink px-2.5 py-0.5 text-xs font-bold text-ink">共 {dayStops.length} 站</span>
                </div>
                <ol className="mt-3 grid gap-2.5">
                  {dayStops.map((stop, idx) => {
                    const qrSvg = buildQrSvgMarkup(stopNavigationUrl(stop, routebook?.city), 64);
                    const price = costDisplay(stop);
                    return (
                      <li key={stop.id ?? idx} className="flex items-center justify-between gap-3 rounded-lg border border-line p-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-extrabold text-ink">
                            {idx + 1}. {stop.time ? `${stop.time} ` : ''}
                            {stop.name}
                          </p>
                          <p className="mt-0.5 text-xs font-semibold text-ink-2">
                            {[stop.area, formatStayText(stop.stay), price.pending ? '' : price.text].filter(Boolean).join(' · ')}
                          </p>
                          {stop.verify && <p className="mt-0.5 text-xs text-muted">留意：{stop.verify}</p>}
                        </div>
                        <div className="flex shrink-0 flex-col items-center">
                          <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                          <span className="text-xs font-semibold text-muted">扫码导航</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

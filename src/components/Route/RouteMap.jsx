import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { cityCenters, distanceKm, isNavigableCoordinate, isValidCoordinate } from '../../lib/coordinates';
import { addBasemap, currentBasemapConfig, escapeHtml, toMapLatLng } from '../map/basemap';
import { stopPhoto } from '../visual/theme';
import { stopKey } from './routebookModel';

/**
 * Direction-B route map. The active day is a thick white-outlined gradient ribbon
 * with numbered pins (photo bubbles only when the stop carries a real photo);
 * other days are faint dotted lines. Approximate coordinates get dashed pins and
 * are excluded from the ribbon and from fitBounds.
 *
 * @param {{
 *   city: string,
 *   days: { day: string, label: string, stops: any[], theme: { solid: string, ink: string, from: string, to: string } }[],
 *   activeDay: string,
 *   selectedId: any,
 *   onSelect: (id: any) => void,
 *   onTileStatus?: (message: string) => void,
 *   fitPadding?: { topLeft: [number, number], bottomRight: [number, number] },
 *   className?: string
 * }} props
 */
export default function RouteMap({ city, days, activeDay, selectedId, onSelect, onTileStatus, fitPadding, className = '' }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const pinsRef = useRef(new Map());
  const [basemap, setBasemap] = useState(currentBasemapConfig);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const padTopLeft = fitPadding?.topLeft ?? [40, 70];
  const padBottomRight = fitPadding?.bottomRight ?? [40, 60];
  const paddingKey = `${padTopLeft.join(',')}|${padBottomRight.join(',')}`;

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const center = cityCenters[city] ?? { lat: 35.8617, lng: 104.1954, zoom: 4 };
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView(
      [center.lat, center.lng],
      center.zoom ?? 12
    );
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    L.control.zoom({ position: 'bottomright', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
    const removeBasemap = addBasemap(map, { onStatus: onTileStatus, onConfig: setBasemap });
    layerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // The map lives in containers that change size (sticky column, mobile full-screen view).
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => map.invalidateSize()) : null;
    observer?.observe(containerRef.current);
    return () => {
      observer?.disconnect();
      removeBasemap();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [city, onTileStatus]);

  // Rebuild layers when the stops / active day change.
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    pinsRef.current = new Map();
    const toLatLng = (stop) => toMapLatLng(Number(stop.lat), Number(stop.lng), basemap);
    let focus = [];
    let fallbackFocus = [];

    days.forEach((entry) => {
      const located = entry.stops.filter((stop) => isValidCoordinate(Number(stop.lat), Number(stop.lng)));
      const navigable = located.filter(isNavigableCoordinate);
      const isActive = entry.day === activeDay;
      if (!isActive) {
        if (navigable.length > 1) {
          L.polyline(navigable.map(toLatLng), {
            color: entry.theme.solid,
            weight: 4,
            opacity: 0.45,
            dashArray: '2 8',
            lineCap: 'round',
            interactive: false
          }).addTo(group);
        }
        navigable.forEach((stop) => {
          L.marker(toLatLng(stop), {
            title: `${entry.label} · ${stop.name}`,
            keyboard: false,
            icon: L.divIcon({ className: '', iconSize: [14, 14], html: `<div class="rb-dot" style="--c:${entry.theme.solid}"></div>` })
          }).addTo(group);
        });
        return;
      }
      if (navigable.length > 1) {
        const points = navigable.map(toLatLng);
        L.polyline(points, { color: '#ffffff', weight: 13, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
        gradientSegments(points, entry.theme.from, entry.theme.to).forEach(([segment, color]) => {
          L.polyline(segment, { color, weight: 8, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
        });
      }
      entry.stops.forEach((stop, index) => {
        if (!isValidCoordinate(Number(stop.lat), Number(stop.lng))) return;
        const approximate = !isNavigableCoordinate(stop);
        const marker = L.marker(toLatLng(stop), {
          title: approximate ? `${stop.name}（位置待确认）` : stop.name,
          alt: stop.name,
          riseOnHover: true,
          icon: pinIcon(stop, index, entry.theme.ink, false, approximate)
        });
        marker.on('click', () => onSelectRef.current?.(stop.id));
        marker.addTo(group);
        pinsRef.current.set(stopKey(stop.id), { marker, stop, index, color: entry.theme.ink, approximate });
      });
      focus = navigable.map(toLatLng);
      fallbackFocus = located.map(toLatLng);
    });

    const bounds = focus.length ? focus : fallbackFocus;
    if (bounds.length) {
      map.fitBounds(L.latLngBounds(bounds), {
        animate: false,
        paddingTopLeft: padTopLeft,
        paddingBottomRight: padBottomRight,
        maxZoom: focus.length ? 15 : 13
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- padding is tracked through paddingKey
  }, [days, activeDay, basemap, paddingKey]);

  // Selection only restyles pins; it never resets the user's pan/zoom.
  useEffect(() => {
    pinsRef.current.forEach((entry, key) => {
      const active = key === stopKey(selectedId);
      entry.marker.setIcon(pinIcon(entry.stop, entry.index, entry.color, active, entry.approximate));
      entry.marker.setZIndexOffset(active ? 1000 : 0);
    });
  }, [selectedId, days, activeDay, basemap]);

  return <div ref={containerRef} className={`rb-map size-full ${className}`} role="region" aria-label="路线地图" />;
}

function pinIcon(stop, index, color, active, approximate) {
  const photo = stopPhoto(stop);
  const label = active ? `<span class="rb-pin-label">${escapeHtml(stop.name)}${approximate ? ' · 位置待确认' : ''}</span>` : '';
  const classes = ['rb-pin', active ? 'active' : '', approximate ? 'approx' : '', photo ? 'has-photo' : ''].filter(Boolean).join(' ');
  const dot = photo
    ? `<span class="rb-pin-dot" style="background-image:url('${escapeHtml(photo)}')"></span><b class="rb-pin-badge">${index + 1}</b>`
    : `<span class="rb-pin-dot">${index + 1}</span>`;
  const size = photo ? [52, 62] : [36, 44];
  return L.divIcon({
    className: '',
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1]],
    html: `<div class="${classes}" style="--c:${color}">${dot}${label}</div>`
  });
}

function gradientSegments(points, from, to, steps = 14) {
  const segments = [];
  const total = points.length - 1;
  for (let s = 0; s < total; s += 1) {
    for (let k = 0; k < steps; k += 1) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const a = lerpPoint(points[s], points[s + 1], t0);
      const b = lerpPoint(points[s], points[s + 1], t1);
      segments.push([[a, b], mixHex(from, to, (s + (t0 + t1) / 2) / total)]);
    }
  }
  return segments;
}

function lerpPoint(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa
    .map((v, i) =>
      Math.round(v + (pb[i] - v) * t)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** Straight-line distance (km) along navigable stops of one day. */
export function dayDistanceKm(stops) {
  const navigable = stops.filter(isNavigableCoordinate);
  let total = 0;
  for (let i = 0; i < navigable.length - 1; i += 1) {
    const km = distanceKm(navigable[i], navigable[i + 1]);
    if (Number.isFinite(km)) total += km;
  }
  return total;
}

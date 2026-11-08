// Small OpenStreetMap minimap built from plain tile images, without a library.
// It fits all stations into view and offers zoom buttons and a link to the
// full map.

import { t } from "./i18n.js";

const TILE_SIZE = 256;
const MIN_ZOOM = 9;
const MAX_ZOOM = 18;
const DEFAULT_ZOOM = 15;
const PADDING = 44;

function project(lat, lon, zoom) {
  const size = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function fittingZoom(stations, width, height) {
  if (stations.length < 2) return DEFAULT_ZOOM;
  for (let zoom = DEFAULT_ZOOM + 1; zoom > MIN_ZOOM; zoom--) {
    const points = stations.map((s) => project(s.lat, s.lon, zoom));
    const spanX = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
    const spanY = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
    if (spanX <= width - PADDING * 2 && spanY <= height - PADDING * 2) return zoom;
  }
  return MIN_ZOOM;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createMap(root, displayName) {
  let stations = [];
  let zoom = DEFAULT_ZOOM;

  const tiles = el("div", "map-tiles");
  const markers = el("div", "map-markers");
  const zoomIn = el("button", "map-zoom", "+");
  const zoomOut = el("button", "map-zoom", "−");
  const open = el("a", "map-open");
  open.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
  const attribution = el("a", "map-credit", "© OpenStreetMap");
  const zoomControls = el("div", "map-controls");

  zoomIn.type = zoomOut.type = "button";
  open.target = attribution.target = "_blank";
  open.rel = attribution.rel = "noopener";
  attribution.href = "https://www.openstreetmap.org/copyright";
  zoomControls.append(zoomIn, zoomOut, open);
  root.append(tiles, markers, zoomControls, attribution);

  function draw() {
    root.hidden = stations.length === 0;
    if (root.hidden) return;
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (!width || !height) return;

    const points = stations.map((s) => project(s.lat, s.lon, zoom));
    const centreX = (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2;
    const centreY = (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
    const left = Math.round(centreX - width / 2);
    const top = Math.round(centreY - height / 2);

    const lastTile = 2 ** zoom - 1;
    const images = [];
    for (let y = Math.floor(top / TILE_SIZE); y <= Math.floor((top + height) / TILE_SIZE); y++) {
      if (y < 0 || y > lastTile) continue;
      for (let x = Math.floor(left / TILE_SIZE); x <= Math.floor((left + width) / TILE_SIZE); x++) {
        if (x < 0 || x > lastTile) continue;
        const image = el("img");
        image.alt = "";
        image.draggable = false;
        image.src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
        image.style.transform = `translate(${x * TILE_SIZE - left}px, ${y * TILE_SIZE - top}px)`;
        images.push(image);
      }
    }
    tiles.replaceChildren(...images);

    markers.replaceChildren(
      ...stations.map((station, index) => {
        const marker = el("div", "map-marker");
        marker.style.transform = `translate(${points[index].x - left}px, ${points[index].y - top}px)`;
        marker.append(el("span", "map-pin"), el("span", "map-label", displayName(station.name)));
        return marker;
      }),
    );

    const lat = stations.reduce((sum, s) => sum + s.lat, 0) / stations.length;
    const lon = stations.reduce((sum, s) => sum + s.lon, 0) / stations.length;
    const pin = stations.length === 1 ? `mlat=${lat}&mlon=${lon}` : "";
    open.href = `https://www.openstreetmap.org/?${pin}#map=${zoom}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
    zoomIn.disabled = zoom >= MAX_ZOOM;
    zoomOut.disabled = zoom <= MIN_ZOOM;
  }

  function changeZoom(delta) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta));
    draw();
  }
  zoomIn.addEventListener("click", () => changeZoom(1));
  zoomOut.addEventListener("click", () => changeZoom(-1));

  // Redraw only when the width changes, so the tiles are not reloaded while
  // the page scrolls or the mobile address bar moves.
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (root.clientWidth !== lastWidth) {
      lastWidth = root.clientWidth;
      setStations(stations);
    }
  }).observe(root);

  function setStations(next) {
    stations = next;
    root.hidden = stations.length === 0;
    if (root.hidden) return;
    zoom = fittingZoom(stations, root.clientWidth, root.clientHeight);
    draw();
  }

  function translate() {
    zoomIn.setAttribute("aria-label", t("mapZoomIn"));
    zoomOut.setAttribute("aria-label", t("mapZoomOut"));
    open.setAttribute("aria-label", t("mapOpen"));
    open.title = t("mapOpen");
  }

  return { setStations, translate };
}

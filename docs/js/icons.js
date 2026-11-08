// Transport symbols and line colours in the style of Berlin public transport
// signage. The symbols are drawn here, not official logo files.

const MODE_COLORS = {
  suburban: "#008d4f",
  subway: "#115d91",
  tram: "#be1414",
  bus: "#95276e",
  regional: "#a5151f",
  express: "#39434a",
  ferry: "#0080ba",
};

const LINE_COLORS = {
  U1: "#7dad4c", U2: "#da421e", U3: "#16683d", U4: "#f0d722", U5: "#7e5330",
  U6: "#8c6dab", U7: "#528dba", U8: "#224f86", U9: "#f3791d",
  S1: "#dc6ba6", S2: "#007734", S25: "#007734", S26: "#007734", S3: "#0066ad",
  S41: "#a23b1e", S42: "#c26a36", S45: "#c38737", S46: "#c38737", S47: "#c38737",
  S5: "#eb7405", S7: "#816da6", S75: "#816da6", S8: "#66aa27", S85: "#66aa27",
  S9: "#992746",
};

const WHITE = "#fff";

function letter(text, size) {
  return (
    `<text x="12" y="${12 + size * 0.36}" text-anchor="middle" fill="${WHITE}" ` +
    `font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="700">${text}</text>`
  );
}

function tram(color) {
  return (
    `<path d="M9.5 3.5h5M12 3.5V6M9 18.5 7.5 21M15 18.5l1.5 2.5" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" fill="none"/>` +
    `<rect x="6.5" y="6" width="11" height="12.5" rx="2.5" fill="${WHITE}"/>` +
    `<rect x="8.3" y="8" width="7.4" height="4.5" rx="1" fill="${color}"/>` +
    `<circle cx="9.5" cy="15.5" r="1.1" fill="${color}"/><circle cx="14.5" cy="15.5" r="1.1" fill="${color}"/>`
  );
}

function bus(color) {
  return (
    `<rect x="4.5" y="4.5" width="15" height="13.5" rx="2.5" fill="${WHITE}"/>` +
    `<rect x="6.3" y="6.7" width="11.4" height="5.3" rx="1" fill="${color}"/>` +
    `<circle cx="8" cy="15" r="1.1" fill="${color}"/><circle cx="16" cy="15" r="1.1" fill="${color}"/>` +
    `<rect x="6.3" y="17.5" width="3" height="2.5" rx="1" fill="${WHITE}"/><rect x="14.7" y="17.5" width="3" height="2.5" rx="1" fill="${WHITE}"/>`
  );
}

function ferry() {
  return (
    `<rect x="11" y="4.5" width="2.8" height="3.5" fill="${WHITE}"/>` +
    `<rect x="7.5" y="8" width="9" height="4.5" rx="0.8" fill="${WHITE}"/>` +
    `<path d="M4 13.2h16l-2.2 4.8H6.2z" fill="${WHITE}"/>` +
    `<path d="M4 20.5c2.7-1.4 5.3 1.4 8 0s5.3 1.4 8 0" stroke="${WHITE}" stroke-width="1.3" stroke-linecap="round" fill="none"/>`
  );
}

const CONTENT = {
  suburban: () => letter("S", 17),
  subway: () => letter("U", 17),
  tram,
  bus,
  regional: () => letter("RE", 12),
  express: () => letter("IC", 12),
  ferry,
};

// Returns a span holding the symbol of a transport type.
export function modeIcon(mode, size = 22) {
  const color = MODE_COLORS[mode] ?? MODE_COLORS.express;
  const shape =
    mode === "suburban"
      ? `<circle cx="12" cy="12" r="12" fill="${color}"/>`
      : `<rect width="24" height="24" rx="${mode === "subway" ? 2.5 : 5}" fill="${color}"/>`;
  const span = document.createElement("span");
  span.className = "mode-icon";
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">` +
    `${shape}${(CONTENT[mode] ?? (() => ""))(color)}</svg>`;
  return span;
}

const CENTRE_ICONS = {
  // Train on tracks
  hbf:
    `<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 10.5h12M9.5 17l-2 4M14.5 17l2 4"/></g>` +
    `<circle cx="9.5" cy="13.8" r="1" fill="currentColor"/><circle cx="14.5" cy="13.8" r="1" fill="currentColor"/>`,
  // Fernsehturm
  alex:
    `<path d="M12 1.5V6M7.5 22h9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>` +
    `<circle cx="12" cy="9.5" r="4" fill="currentColor"/>` +
    `<path d="M11 13h2l1 9h-4z" fill="currentColor"/>`,
  // Tiger face
  zoo:
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6">` +
    `<path d="M5.1 7.4a2.9 2.9 0 1 1 3.8-3.6M18.9 7.4a2.9 2.9 0 1 0-3.8-3.6"/>` +
    `<path d="M12 3c-4.8 0-8.5 3.7-8.5 8.6 0 5.2 3.8 9.4 8.5 9.4s8.5-4.2 8.5-9.4C20.5 6.7 16.8 3 12 3z"/>` +
    `<path d="M12 3.2v3.6M8.8 3.8l.8 2.6M15.2 3.8l-.8 2.6M3.8 11.5h3M4.5 15.4l2.7-1M20.2 11.5h-3M19.5 15.4l-2.7-1"/>` +
    `<path d="M12 16.2v1.3M12 17.5c-.6 1-1.8 1.1-2.6.4M12 17.5c.6 1 1.8 1.1 2.6.4" stroke-width="1.2"/></g>` +
    `<circle cx="9" cy="10.8" r="1.25" fill="currentColor"/><circle cx="15" cy="10.8" r="1.25" fill="currentColor"/>` +
    `<path d="M10.4 14.2h3.2L12 16.3z" fill="currentColor"/>`,
};

// Returns a span holding the symbol of a reference point. It takes the colour
// of the surrounding text, so it follows the button's selected state and theme.
export function centreIcon(id, size = 24) {
  const span = document.createElement("span");
  span.className = "mode-icon";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${CENTRE_ICONS[id]}</svg>`;
  return span;
}

// Returns a span holding a star. CSS fills it when the place is a favorite.
export function starIcon() {
  const span = document.createElement("span");
  span.className = "star-icon";
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>`;
  return span;
}

// The API sometimes omits the S, as in "46" for the S46. Long-distance names
// carry a train number ("ICE 1107") that does not fit and helps nobody here.
export function lineName(departure) {
  const name = departure.line || "?";
  if (departure.product === "suburban" && /^\d/.test(name)) return `S${name}`;
  if (departure.product === "express") return name.split(" ")[0];
  return name;
}

// Background and readable text colour for a departure's line.
export function lineColors(departure) {
  const background =
    LINE_COLORS[lineName(departure)] ?? MODE_COLORS[departure.product] ?? MODE_COLORS.express;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return { background, color: brightness > 170 ? "#1a2329" : WHITE };
}

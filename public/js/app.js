import { WINDOW_MINUTES, getDepartures, searchStations } from "./api.js";
import { CENTRES, DEFAULT_CENTRE, classify, isAtCentre } from "./direction.js";
import { preferredLanguage, setLanguage, t } from "./i18n.js";
import { centreIcon, lineColors, lineName, modeIcon, starIcon } from "./icons.js";
import { createMap } from "./map.js";

const AUTO_REFRESH_MS = 2 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;
// An automatic refresh starts up to a moment after the full minute. Without this
// allowance, that delay would round the next one up to 3 minutes instead of 2.
const AUTO_TIMER_LAG_MS = 3 * 1000;
const BOARD_REDRAW_MS = 15 * 1000;
const SEARCH_DELAY_MS = 250;
const MAX_ROWS = 150;
const SLIDER_MAX = WINDOW_MINUTES;
const WALK_STEP = 0.5; // minutes
const WALK_MAX = 30;
const LEAVE_SOON_MIN = 3; // below this the leave time turns yellow
const LEAVE_CAP_MIN = 10; // beyond this the label only says "more than 10"
const DEFAULT_MIN = 2;
const DEFAULT_MAX = 20;
const MAX_SLIDER_STEP = 5;

const MODES = ["suburban", "subway", "tram", "bus", "regional", "express", "ferry"];
const DIRECTIONS = [
  { id: "both", label: "dirBoth" },
  { id: "inward", label: "dirInward" },
  { id: "outward", label: "dirOutward" },
];
const DIRECTION_LABELS = { inward: "dirInward", outward: "dirOutward", ring: "dirRing" };

const SETTINGS_KEY = "abfahrt.settings.v1";
const DATA_KEY = "abfahrt.data.v1";

const $ = (id) => document.getElementById(id);

// ---------- Saved state ----------

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked: the app keeps working for this visit.
  }
}

// Smallest allowed value of the maximum slider that is above the given minute.
function maxAbove(minute) {
  return (Math.floor(minute / MAX_SLIDER_STEP) + 1) * MAX_SLIDER_STEP;
}

function loadSettings() {
  const saved = readStorage(SETTINGS_KEY);
  const min = Number.isInteger(saved.min) ? saved.min : DEFAULT_MIN;
  const max = Number.isInteger(saved.max) ? saved.max : DEFAULT_MAX;
  return {
    stations: Array.isArray(saved.stations) ? saved.stations : [],
    favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
    walkTimes: Object.fromEntries(
      Object.entries(saved.walkTimes ?? {}).filter(
        ([, minutes]) => typeof minutes === "number" && minutes > 0 && minutes <= WALK_MAX,
      ),
    ),
    min: Math.min(Math.max(min, 0), SLIDER_MAX - 1),
    max: Math.min(Math.max(maxAbove(max - 1), maxAbove(min)), SLIDER_MAX),
    modes: Array.isArray(saved.modes) ? saved.modes.filter((m) => MODES.includes(m)) : MODES,
    direction: DIRECTIONS.some((d) => d.id === saved.direction) ? saved.direction : "both",
    centre: Object.hasOwn(CENTRES, saved.centre) ? saved.centre : DEFAULT_CENTRE,
    language: saved.language === "de" || saved.language === "en" ? saved.language : preferredLanguage(),
  };
}

const settings = loadSettings();
const data = { departures: {}, updatedAt: 0, lastRefresh: 0, ...readStorage(DATA_KEY) };

const runtime = {
  loading: false,
  failed: [],
  pending: new Set(),
};

const saveSettings = () => writeStorage(SETTINGS_KEY, settings);
const saveData = () => writeStorage(DATA_KEY, data);

// ---------- Small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function displayName(name) {
  return (name || "").replace(/\s*\(Berlin\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clock(date, seconds = false) {
  return date.toLocaleTimeString(settings.language === "de" ? "de-DE" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

// ---------- Loading departures ----------

async function loadStations(stations) {
  stations.forEach((s) => runtime.pending.add(s.id));
  renderBoard();
  const results = await Promise.allSettled(stations.map((s) => getDepartures(s.id)));
  results.forEach((result, index) => {
    const station = stations[index];
    runtime.pending.delete(station.id);
    runtime.failed = runtime.failed.filter((id) => id !== station.id);
    if (result.status === "fulfilled") {
      data.departures[station.id] = result.value;
    } else {
      runtime.failed.push(station.id);
    }
  });
  if (results.some((r) => r.status === "fulfilled")) data.updatedAt = Date.now();
  saveData();
  renderBoard();
}

async function refresh() {
  if (runtime.loading || settings.stations.length === 0) return;
  runtime.loading = true;
  data.lastRefresh = Date.now();
  saveData();
  renderTimers();
  try {
    await loadStations(settings.stations);
  } finally {
    runtime.loading = false;
    renderTimers();
  }
}

function cooldownLeft() {
  return data.lastRefresh + REFRESH_COOLDOWN_MS - Date.now();
}

// The first full minute at least 2 minutes after the last refresh.
function nextAutoRefresh() {
  const earliest = data.lastRefresh + AUTO_REFRESH_MS - AUTO_TIMER_LAG_MS;
  return Math.ceil(earliest / MINUTE_MS) * MINUTE_MS;
}

// Runs once per second. Timestamps instead of separate timers keep this
// correct after the phone sleeps or the tab is suspended.
function tick() {
  if (settings.stations.length > 0 && !runtime.loading) {
    if (Date.now() >= nextAutoRefresh() && !document.hidden) refresh();
  }
  renderTimers();
}

// ---------- Rendering: refresh button and status ----------

function renderTimers() {
  const button = $("refresh");
  const hasStations = settings.stations.length > 0;
  const wait = cooldownLeft();
  const waiting = hasStations && !runtime.loading && wait > 0;

  button.disabled = !hasStations || runtime.loading || waiting;
  button.classList.toggle("is-loading", runtime.loading);
  button.classList.toggle("is-waiting", waiting);

  let label = t("refresh");
  if (runtime.loading) {
    label = t("refreshing");
  } else if (waiting) {
    label = t("waitFor", { time: formatCountdown(wait) });
  }
  button.setAttribute("aria-label", label);
  button.title = label;

  let status = "";
  if (hasStations) {
    status = data.updatedAt ? t("updated", { time: clock(new Date(data.updatedAt), true) }) : t("never");
    if (!runtime.loading) {
      const next = t("nextAuto", { time: formatCountdown(nextAutoRefresh() - Date.now()) });
      status += ` (${next})`;
    }
  }
  $("status").textContent = status;
}

function renderTitle() {
  const names = settings.stations.map((s) => displayName(s.name)).join(", ");
  $("boardTitle").textContent = names || t("departures");
}

function setSettingsOpen(open) {
  $("settings").hidden = !open;
  $("settingsToggle").setAttribute("aria-expanded", String(open));
}

// ---------- Rendering: departures ----------

function departureTime(departure) {
  return new Date(departure.when || departure.planned).getTime();
}

function visibleDepartures() {
  const now = Date.now();
  const seen = new Set();
  const rows = [];
  for (const station of settings.stations) {
    for (const departure of data.departures[station.id] || []) {
      // Two selected stations can share a platform, which would list a trip twice.
      const key = `${departure.tripId}|${departure.stopId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!settings.modes.includes(departure.product)) continue;
      const time = departureTime(departure);
      const minutes = (time - now) / 60000;
      const earliest = settings.min === 0 ? -0.5 : settings.min;
      if (Number.isNaN(time) || minutes < earliest || minutes > settings.max) continue;

      const direction = classify(station, departure, CENTRES[settings.centre]);
      if (settings.direction !== "both" && settings.direction !== direction) continue;
      rows.push({ departure, station, direction, time, minutes });
    }
  }
  return rows.sort((a, b) => a.time - b.time);
}

// When the walk to the station has to start, based on its saved walking time.
// Returns null when no walking time is set for the station.
function reachability(station, departure, minutes) {
  const walk = settings.walkTimes[station.id] || 0;
  if (!walk || departure.cancelled) return null;
  const leaveIn = minutes - walk;
  if (leaveIn < 0) return { status: "late", text: t("tooLate") };
  if (leaveIn < 1) return { status: "now", text: t("leaveNow") };
  const n = Math.floor(leaveIn);
  return {
    status: leaveIn < LEAVE_SOON_MIN ? "soon" : "ok",
    text: n > LEAVE_CAP_MIN ? t("leaveLater", { n: LEAVE_CAP_MIN }) : t("leaveIn", { n }),
  };
}

function formatMinutes(value) {
  return value.toLocaleString(settings.language === "de" ? "de-DE" : "en-GB");
}

function renderWalkTimes() {
  $("walkLabel").hidden = settings.stations.length === 0;
  $("walkTimes").replaceChildren(
    ...settings.stations.map((station) => {
      const name = displayName(station.name);
      const value = settings.walkTimes[station.id] || 0;
      const change = (step) => {
        const next = Math.min(WALK_MAX, Math.max(0, value + step));
        const { [station.id]: _, ...others } = settings.walkTimes;
        settings.walkTimes = next > 0 ? { ...others, [station.id]: next } : others;
        saveSettings();
        renderWalkTimes();
        renderBoard();
      };
      const less = el("button", "walk-step", "−");
      const more = el("button", "walk-step", "+");
      less.type = more.type = "button";
      less.disabled = value <= 0;
      more.disabled = value >= WALK_MAX;
      less.setAttribute("aria-label", t("walkLess", { name }));
      more.setAttribute("aria-label", t("walkMore", { name }));
      less.addEventListener("click", () => change(-WALK_STEP));
      more.addEventListener("click", () => change(WALK_STEP));
      const shown = value ? t("minutes", { n: formatMinutes(value) }) : t("walkOff");
      const controls = el("span", "walk-controls");
      controls.append(less, el("span", "walk-value", shown), more);
      const item = el("li", "walk-row");
      item.append(el("span", "walk-name", name), controls);
      return item;
    }),
  );
}

function renderRow({ departure, station, direction, time, minutes }) {
  const row = el("li", "departure");
  if (departure.cancelled) row.classList.add("is-cancelled");

  const lineChip = el("span", `line line-${departure.product}`, lineName(departure));
  const colors = lineColors(departure);
  lineChip.style.background = colors.background;
  lineChip.style.color = colors.color;
  const line = el("div", "departure-line");
  line.append(modeIcon(departure.product), lineChip);

  const main = el("div", "departure-main");
  main.append(el("span", "departure-direction", displayName(departure.direction)));

  const details = [];
  if (settings.stations.length > 1) details.push(displayName(station.name));
  if (departure.platform) {
    const isNumber = /^\d/.test(departure.platform);
    details.push(isNumber ? t("platform", { p: departure.platform }) : departure.platform);
  }
  if (DIRECTION_LABELS[direction]) details.push(t(DIRECTION_LABELS[direction]));
  const detailLine = el("span", "departure-details", details.join(" · "));
  const reach = reachability(station, departure, minutes);
  if (reach) {
    row.classList.add(`reach-${reach.status}`);
    detailLine.prepend(el("span", `leave leave-${reach.status}`, reach.text));
  }
  main.append(detailLine);

  const when = el("div", "departure-when");
  if (departure.cancelled) {
    when.append(el("span", "departure-relative", t("cancelled")));
  } else {
    const label = minutes < 1 ? t("now") : t("inMinutes", { n: Math.floor(minutes) });
    when.append(el("span", "departure-relative", label));
  }
  const clockLine = el("span", "departure-clock", clock(new Date(time)));
  const delayMinutes = Math.round((departure.delay || 0) / 60);
  if (!departure.cancelled && delayMinutes !== 0) {
    const delay = el("span", delayMinutes > 0 ? "delay" : "early", ` ${delayMinutes > 0 ? "+" : "−"}${Math.abs(delayMinutes)}`);
    clockLine.append(delay);
  }
  when.append(clockLine);

  row.append(line, main, when);
  return row;
}

function emptyMessage() {
  if (settings.stations.length === 0) return t("emptyNoStation");
  const hasData = settings.stations.some((s) => data.departures[s.id]);
  if (!hasData && (runtime.pending.size > 0 || runtime.loading)) return t("emptyLoading");
  if (settings.modes.length === 0) return t("emptyNoModes");
  const centre = CENTRES[settings.centre];
  if (settings.direction === "inward" && settings.stations.every((s) => isAtCentre(s, centre))) {
    return t("emptyCentral", { place: centre.name });
  }
  return t("emptyFiltered");
}

function renderNotice() {
  const notice = $("notice");
  let message = "";
  const failed = settings.stations.filter((s) => runtime.failed.includes(s.id));
  if (failed.length > 0) {
    message = t("errorLoad", { names: failed.map((s) => displayName(s.name)).join(", ") });
  }
  notice.textContent = message;
  notice.hidden = !message;
}

// The list keeps one element per departure between redraws, so rows can glide
// to their new place, fade out when they leave and fade in when they arrive.
const MOTION_MS = 1200; // rows gliding and the list resizing
const ENTER_MS = 2200; // new rows fade in and their highlight fades away
const LEAVE_MS = 1000; // old rows dim, shrink slightly and fade out
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const rowElements = new Map();

function rowKey({ departure }) {
  return `${departure.tripId}|${departure.stopId}|${departure.line}|${departure.planned}`;
}

// Row positions relative to the list, including animations still running.
function rowOffsets(list) {
  const top = list.getBoundingClientRect().top + list.clientTop;
  const offsets = new Map();
  for (const [key, li] of rowElements) offsets.set(key, li.getBoundingClientRect().top - top);
  return offsets;
}

function animateBoard(list, before, oldHeight, leaving) {
  const after = rowOffsets(list);
  const styles = getComputedStyle(document.documentElement);
  const flash = styles.getPropertyValue("--flash").trim();
  const surface = styles.getPropertyValue("--surface").trim();
  for (const [key, li] of rowElements) {
    const from = before.get(key);
    if (from === undefined) {
      // Flashes up in the highlight colour, then settles into the list.
      li.animate(
        [
          { opacity: 0, transform: "scale(0.97)", backgroundColor: flash },
          { opacity: 1, transform: "scale(1.01)", backgroundColor: flash, offset: 0.25 },
          { opacity: 1, transform: "none", backgroundColor: surface },
        ],
        { duration: ENTER_MS, easing: "ease-out" },
      );
    } else if (Math.abs(from - after.get(key)) > 0.5) {
      li.animate(
        [{ transform: `translateY(${from - after.get(key)}px)` }, { transform: "none" }],
        { duration: MOTION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
  }

  // Leaving rows stay where they were, out of the flow, while they fade.
  for (const [key, li] of leaving) {
    li.classList.add("is-leaving");
    li.style.top = `${before.get(key)}px`;
    list.append(li);
    // The opposite of arriving: dims, shrinks slightly and fades away.
    const fade = li.animate(
      [
        { opacity: 1, transform: "none", filter: "none" },
        { opacity: 0, transform: "scale(0.96)", filter: "grayscale(1) brightness(0.7)" },
      ],
      { duration: LEAVE_MS, easing: "ease-in", fill: "forwards" },
    );
    fade.onfinish = () => li.remove();
  }

  const newHeight = list.getBoundingClientRect().height;
  if (oldHeight > 0 && newHeight > 0 && Math.abs(oldHeight - newHeight) > 0.5) {
    list.animate([{ height: `${oldHeight}px` }, { height: `${newHeight}px` }], {
      duration: MOTION_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  }
}

function renderBoard() {
  const rows = visibleDepartures();
  const list = $("departures");
  const animate = rowElements.size > 0 && !reduceMotion.matches && !document.hidden;
  const before = animate ? rowOffsets(list) : new Map();
  const oldHeight = list.getBoundingClientRect().height;
  list.getAnimations().forEach((animation) => animation.cancel());

  const current = new Map();
  const items = rows.slice(0, MAX_ROWS).map((row) => {
    const key = rowKey(row);
    const fresh = renderRow(row);
    const li = rowElements.get(key) ?? fresh;
    if (li !== fresh) {
      li.className = fresh.className;
      li.replaceChildren(...fresh.childNodes);
    }
    li.getAnimations().forEach((animation) => animation.cancel());
    current.set(key, li);
    return li;
  });
  if (rows.length > MAX_ROWS) {
    items.push(el("li", "more-rows", t("moreRows", { n: rows.length - MAX_ROWS })));
  }

  const leaving = [...rowElements].filter(([key]) => !current.has(key));
  rowElements.clear();
  current.forEach((li, key) => rowElements.set(key, li));
  list.replaceChildren(...items);
  if (animate) animateBoard(list, before, oldHeight, leaving);
  const empty = $("empty");
  empty.hidden = rows.length > 0;
  empty.textContent = rows.length > 0 ? "" : emptyMessage();
  renderNotice();
}

// ---------- Rendering: controls ----------

function starButton(station) {
  const on = settings.favorites.some((s) => s.id === station.id);
  const name = displayName(station.name);
  const star = el("button", "chip-star");
  star.type = "button";
  star.append(starIcon());
  star.setAttribute("aria-pressed", String(on));
  star.setAttribute("aria-label", t(on ? "removeFavorite" : "addFavorite", { name }));
  star.addEventListener("click", () => toggleFavorite(station));
  return star;
}

function renderChips() {
  $("chips").replaceChildren(
    ...settings.stations.map((station) => {
      const chip = el("li", "chip");
      const remove = el("button", "chip-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", t("removeStation", { name: displayName(station.name) }));
      remove.addEventListener("click", () => removeStation(station.id));
      chip.append(starButton(station), el("span", "chip-name", displayName(station.name)), remove);
      return chip;
    }),
  );

  renderWalkTimes();

  // Favorites that are selected already appear above with a filled star.
  const others = settings.favorites.filter((f) => !settings.stations.some((s) => s.id === f.id));
  $("favoritesLabel").hidden = others.length === 0;
  $("favorites").replaceChildren(
    ...others.map((station) => {
      const name = displayName(station.name);
      const chip = el("li", "chip chip-favorite");
      const show = el("button", "chip-show", name);
      show.type = "button";
      show.setAttribute("aria-label", t("showStation", { name }));
      show.addEventListener("click", () => activateStation(station));
      chip.append(starButton(station), show);
      return chip;
    }),
  );
}

function renderFilters() {
  $("minTime").value = settings.min;
  $("maxTime").value = settings.max;
  $("minTimeOut").textContent = t("minutes", { n: settings.min });
  $("maxTimeOut").textContent = t("minutes", { n: settings.max });

  $("modes").replaceChildren(
    ...MODES.map((mode) => {
      const on = settings.modes.includes(mode);
      const button = el("button", "mode");
      button.type = "button";
      button.append(modeIcon(mode, 20), el("span", null, t(mode)));
      button.setAttribute("aria-pressed", String(on));
      button.addEventListener("click", () => {
        settings.modes = on
          ? settings.modes.filter((m) => m !== mode)
          : [...settings.modes, mode];
        filtersChanged();
      });
      return button;
    }),
  );

  $("directions").replaceChildren(
    ...DIRECTIONS.map((direction) => {
      const button = el("button", "segment", t(direction.label));
      button.type = "button";
      button.setAttribute("aria-pressed", String(settings.direction === direction.id));
      button.addEventListener("click", () => {
        settings.direction = direction.id;
        filtersChanged();
      });
      return button;
    }),
  );

  const centreText = { inward: "towardsPlace", outward: "awayFromPlace" }[settings.direction];
  $("centreLabel").hidden = !centreText;
  $("centres").hidden = !centreText;
  $("centres").replaceChildren(
    ...Object.entries(CENTRES).map(([id, centre]) => {
      const button = el("button", "segment segment-icon");
      button.type = "button";
      button.append(centreIcon(id), el("span", null, t(centreText ?? "towardsPlace", { place: centre.label })));
      button.title = centre.name;
      button.setAttribute("aria-pressed", String(settings.centre === id));
      button.addEventListener("click", () => {
        settings.centre = id;
        filtersChanged();
      });
      return button;
    }),
  );
}

function filtersChanged() {
  saveSettings();
  renderFilters();
  renderBoard();
}

function renderLanguage() {
  setLanguage(settings.language);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === settings.language));
  });
  map.translate();
  renderTitle();
  renderChips();
  renderFilters();
  renderBoard();
  renderTimers();
}

// ---------- Station selection ----------

function stationsChanged() {
  saveSettings();
  renderTitle();
  renderChips();
  map.setStations(settings.stations);
  renderBoard();
  renderTimers();
}

function activateStation(station) {
  if (settings.stations.some((s) => s.id === station.id)) return;
  const { id, name, lat, lon } = station;
  settings.stations.push({ id, name, lat, lon });
  stationsChanged();
  // Loads only the new station, so this does not use up the manual refresh.
  if (data.lastRefresh === 0) refresh();
  else loadStations([station]);
}

function toggleFavorite(station) {
  const { id, name, lat, lon } = station;
  settings.favorites = settings.favorites.some((s) => s.id === id)
    ? settings.favorites.filter((s) => s.id !== id)
    : [...settings.favorites, { id, name, lat, lon }];
  saveSettings();
  renderChips();
}

function addStation(station) {
  activateStation(station);
  closeResults();
  $("search").value = "";
  $("search").focus();
}

function removeStation(id) {
  settings.stations = settings.stations.filter((s) => s.id !== id);
  delete data.departures[id];
  runtime.failed = runtime.failed.filter((failedId) => failedId !== id);
  saveData();
  stationsChanged();
}

// ---------- Station search ----------

let searchTimer;
let searchController;

function closeResults() {
  clearTimeout(searchTimer);
  searchController?.abort();
  $("results").hidden = true;
  $("results").replaceChildren();
  $("search").setAttribute("aria-expanded", "false");
}

function showResultMessage(message) {
  $("results").replaceChildren(el("li", "result-message", message));
  $("results").hidden = false;
}

function showResults(stations) {
  if (stations.length === 0) {
    showResultMessage(t("noResults"));
    return;
  }
  $("results").replaceChildren(
    ...stations.map((station) => {
      const item = el("li");
      const button = el("button", "result");
      button.type = "button";
      button.append(el("span", "result-name", displayName(station.name)));
      const badges = el("span", "result-modes");
      for (const mode of MODES) {
        if (station.products.includes(mode)) badges.append(modeIcon(mode, 18));
      }
      button.append(badges);
      button.addEventListener("click", () => addStation(station));
      item.append(button);
      return item;
    }),
  );
  $("results").hidden = false;
  $("search").setAttribute("aria-expanded", "true");
}

function onSearchInput() {
  clearTimeout(searchTimer);
  searchController?.abort();
  const query = $("search").value.trim();
  if (query.length < 2) {
    closeResults();
    return;
  }
  searchTimer = setTimeout(async () => {
    searchController = new AbortController();
    try {
      showResults(await searchStations(query, searchController.signal));
    } catch (error) {
      if (error.name !== "AbortError") showResultMessage(t("searchFailed"));
    }
  }, SEARCH_DELAY_MS);
}

function moveResultFocus(step) {
  const buttons = [...$("results").querySelectorAll("button")];
  if (buttons.length === 0) return;
  const index = buttons.indexOf(document.activeElement);
  const next = index + step;
  if (next < 0) $("search").focus();
  else buttons[Math.min(next, buttons.length - 1)].focus();
}

// ---------- Wiring ----------

const map = createMap($("map"), displayName);

$("search").addEventListener("input", onSearchInput);
$("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("results").querySelector("button")?.click();
  }
});
document.querySelector(".search").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveResultFocus(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveResultFocus(-1);
  } else if (event.key === "Escape") {
    closeResults();
    $("search").focus();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search")) closeResults();
});

$("minTime").addEventListener("input", (event) => {
  settings.min = Number(event.target.value);
  if (settings.max <= settings.min) settings.max = maxAbove(settings.min);
  filtersChanged();
});
$("maxTime").addEventListener("input", (event) => {
  settings.max = Number(event.target.value);
  if (settings.min >= settings.max) settings.min = settings.max - 1;
  filtersChanged();
});

$("refresh").addEventListener("click", refresh);

document.querySelectorAll("[data-lang]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.language = button.dataset.lang;
    saveSettings();
    renderLanguage();
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    tick();
    renderBoard();
  }
});

$("settingsToggle").addEventListener("click", () => setSettingsOpen($("settings").hidden));
$("settingsDone").addEventListener("click", () => {
  setSettingsOpen(false);
  window.scrollTo(0, 0);
});

// A click outside the panel and the top bar closes the panel. The event path is
// used because the panel redraws some buttons on click, which removes the clicked
// element from the page.
document.addEventListener("click", (event) => {
  const path = event.composedPath();
  if (!path.includes($("settings")) && !path.includes(document.querySelector(".topbar"))) {
    setSettingsOpen(false);
  }
});

// Once stations are saved the app opens on the departures alone.
setSettingsOpen(settings.stations.length === 0);

renderLanguage();
map.setStations(settings.stations);

// Saved data shows immediately. Stations with no saved data load right away;
// everything else waits for the regular refresh timing, including after reloads.
const unloaded = settings.stations.filter((s) => !data.departures[s.id]);
if (cooldownLeft() <= 0) refresh();
else if (unloaded.length > 0) loadStations(unloaded);

setInterval(tick, 1000);
setInterval(renderBoard, BOARD_REDRAW_MS);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => {
    console.warn("Service worker not registered:", error);
  });
}

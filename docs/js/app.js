import { WINDOW_MINUTES, getDepartures, searchStations } from "./api.js";
import { CENTRES, DEFAULT_CENTRE, classify, isAtCentre } from "./direction.js";
import { preferredLanguage, setLanguage, t } from "./i18n.js";
import { centreIcon, lineColors, lineName, modeIcon, starIcon } from "./icons.js";
import { createMap } from "./map.js";
import { setupPullToRefresh } from "./pull.js";

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
// Walking times in minutes: half minutes up to 5, then whole minutes up to 15.
const WALK_VALUES = [
  ...Array.from({ length: 11 }, (_, i) => i / 2),
  ...Array.from({ length: 10 }, (_, i) => 6 + i),
];
const WALK_MAX = WALK_VALUES.at(-1);

// The allowed walking time closest to a saved one, for values saved by older versions.
function nearestWalkValue(minutes) {
  return WALK_VALUES.reduce((best, v) => (Math.abs(v - minutes) < Math.abs(best - minutes) ? v : best));
}
const LEAVE_SOON_MIN = 3; // below this the leave time turns yellow
const LEAVE_CAP_MIN = 10; // beyond this the label only says "more than 10"
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 15;
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
      Object.entries(saved.walkTimes ?? {})
        .filter(([, minutes]) => typeof minutes === "number" && minutes > 0)
        .map(([id, minutes]) => [id, nearestWalkValue(Math.min(minutes, WALK_MAX))]),
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
const data = { departures: {}, updatedAt: 0, lastRefresh: 0, selected: null, past: [], ...readStorage(DATA_KEY) };
const validEntry = (e) => Boolean(e && e.key && e.station && e.departure);
if (!validEntry(data.selected)) data.selected = null;
data.past = Array.isArray(data.past) ? data.past.filter((e) => validEntry(e) && e.goneAt) : [];

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
  const walk = walkTime(station);
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

function walkTime(station) {
  return settings.walkTimes[station.id] || 0;
}

function walkLabel(minutes) {
  return minutes ? t("minutes", { n: formatMinutes(minutes) }) : t("walkOff");
}

// One slider per station. The slider counts positions in WALK_VALUES, which gives
// half minutes up to 5 and whole minutes after that.
function renderWalkTimes() {
  $("walkLabel").hidden = settings.stations.length === 0;
  $("walkTimes").replaceChildren(
    ...settings.stations.map((station) => {
      const value = el("output", "walk-value");
      const range = el("div", "range");
      const input = el("input");
      input.type = "range";
      input.min = 0;
      input.max = WALK_VALUES.length - 1;
      input.step = 1;
      input.setAttribute("aria-label", t("walkFor", { name: displayName(station.name) }));
      range.append(el("div", "range-track"), input);
      range.firstChild.append(el("div", "range-fill"));

      // Updates this row in place: redrawing the list would end the drag.
      const show = (minutes) => {
        const label = walkLabel(minutes);
        value.textContent = label;
        input.value = WALK_VALUES.indexOf(minutes);
        input.setAttribute("aria-valuetext", label);
        range.style.setProperty("--from", 0);
        range.style.setProperty("--to", input.value / input.max);
      };
      input.addEventListener("input", () => {
        const minutes = WALK_VALUES[Number(input.value)];
        const { [station.id]: _, ...others } = settings.walkTimes;
        settings.walkTimes = minutes > 0 ? { ...others, [station.id]: minutes } : others;
        saveSettings();
        show(minutes);
        renderBoard();
      });
      show(walkTime(station));

      const item = el("li", "walk-row");
      item.append(el("span", "walk-name", displayName(station.name)), value, range);
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

  const selectedKey = updateSelection(rows);
  current.forEach((li, key) => markSelectable(li, key, key === selectedKey));

  const leaving = [...rowElements].filter(([key]) => !current.has(key));
  rowElements.clear();
  current.forEach((li, key) => rowElements.set(key, li));
  // Re-inserting the rows would drop keyboard focus, so it is put back.
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  list.replaceChildren(...items);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  if (animate) animateBoard(list, before, oldHeight, leaving);
  const empty = $("empty");
  empty.hidden = rows.length > 0;
  empty.textContent = rows.length > 0 ? "" : emptyMessage();
  renderGone();
  renderNotice();
}

// ---------- Selected connection ----------

// One departure can be selected and is highlighted. Once a selected departure is
// no longer listed, it moves to the "past connections" section below the list
// and stays there for GONE_KEEP_MS, also after it is deselected (data.past).
//
// Taps: with nothing selected, a tap selects. With a selection, any tap on a
// departure only deselects, so switching takes two taps.
const GONE_KEEP_MS = 5 * 60 * 1000;

function markSelectable(li, key, selected) {
  li.dataset.key = key;
  li.tabIndex = 0;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(selected));
  li.classList.toggle("is-selected", selected);
}

const expired = (entry) => Date.now() - entry.goneAt > GONE_KEEP_MS;

// Keeps the saved copy of the selected departure current while it is listed,
// notes when it left the list and drops past entries after their time.
// Returns the key of a selection that is still in the list.
function updateSelection(rows) {
  const listed = new Set(rows.map(rowKey));
  let changed = false;

  // A past entry that is listed again (a filter was widened) is simply a normal row.
  const past = data.past.filter((entry) => !expired(entry) && !listed.has(entry.key));
  if (past.length !== data.past.length) {
    data.past = past;
    changed = true;
  }

  const selected = data.selected;
  let selectedKey = null;
  if (selected) {
    const row = rows.find((r) => rowKey(r) === selected.key);
    if (row) {
      selected.departure = row.departure;
      if (selected.goneAt) selected.goneAt = null;
      selectedKey = selected.key;
      changed = true;
    } else if (!selected.goneAt) {
      selected.goneAt = Date.now();
      changed = true;
    } else if (expired(selected)) {
      data.selected = null;
      changed = true;
    }
  }
  if (changed) saveData();
  return selectedKey;
}

// Ends the selection. A selection that has already left the list stays in the
// past section, without the highlight, until its time is up.
function deselect() {
  const selected = data.selected;
  data.selected = null;
  if (selected?.goneAt) data.past = [...data.past.filter((e) => e.key !== selected.key), selected];
}

function select(key) {
  const row = visibleDepartures().find((r) => rowKey(r) === key);
  const pastEntry = data.past.find((e) => e.key === key);
  if (row) {
    data.selected = { key, station: row.station, departure: row.departure, goneAt: null };
  } else if (pastEntry) {
    data.selected = pastEntry;
  } else {
    return;
  }
  data.past = data.past.filter((e) => e.key !== key);
}

function renderPastRow(entry, selected) {
  // The latest data for the trip if it is still there, otherwise the saved copy.
  const fresh = (data.departures[entry.station.id] || []).find(
    (d) => rowKey({ departure: d }) === entry.key,
  );
  const departure = fresh || entry.departure;
  const time = departureTime(departure);
  const minutes = (time - Date.now()) / 60000;
  const direction = classify(entry.station, departure, CENTRES[settings.centre]);

  const li = renderRow({ departure, station: entry.station, direction, time, minutes });
  li.classList.add("is-gone");
  if (minutes <= -0.5) {
    // A leave time makes no sense any more once the train has gone.
    li.classList.remove("reach-ok", "reach-soon", "reach-now", "reach-late");
    li.querySelector(".leave")?.remove();
    if (!departure.cancelled) {
      const ago = Math.max(1, Math.floor(-minutes));
      li.querySelector(".departure-relative").textContent = t("minutesAgo", { n: ago });
    }
  }
  markSelectable(li, entry.key, selected);
  return { li, time };
}

function renderGone() {
  const entries = [
    ...data.past.map((entry) => renderPastRow(entry, false)),
    ...(data.selected?.goneAt ? [renderPastRow(data.selected, true)] : []),
  ].sort((a, b) => a.time - b.time);
  $("gone").hidden = entries.length === 0;
  const list = $("goneList");
  const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  list.replaceChildren(...entries.map((e) => e.li));
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
}

function onDepartureActivate(event) {
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  const li = event.target.closest(".departure[data-key]");
  if (!li || li.classList.contains("is-leaving")) return;
  if (event.type === "keydown") event.preventDefault();
  if (data.selected) deselect();
  else select(li.dataset.key);
  saveData();
  renderBoard();
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
  $("minTime").setAttribute("aria-valuetext", t("minutes", { n: settings.min }));
  $("maxTime").setAttribute("aria-valuetext", t("minutes", { n: settings.max }));
  $("timeRangeOut").textContent = t("timeRangeValue", { min: settings.min, max: settings.max });
  const range = $("timeRange");
  range.style.setProperty("--from", settings.min / SLIDER_MAX);
  range.style.setProperty("--to", settings.max / SLIDER_MAX);
  // Near the right end the earliest handle has to lie on top, or it could not be
  // dragged back out from under the latest handle.
  $("minTime").classList.toggle("is-front", settings.min > SLIDER_MAX / 2);

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

// The two handles stop at each other instead of pushing each other along.
$("minTime").addEventListener("input", (event) => {
  settings.min = Math.min(Number(event.target.value), settings.max - 1);
  filtersChanged();
});
$("maxTime").addEventListener("input", (event) => {
  settings.max = Math.max(Number(event.target.value), maxAbove(settings.min), MAX_SLIDER_STEP);
  filtersChanged();
});

$("refresh").addEventListener("click", refresh);

for (const list of [$("departures"), $("goneList")]) {
  list.addEventListener("click", onDepartureActivate);
  list.addEventListener("keydown", onDepartureActivate);
}

// The pull indicator uses the same symbol as the refresh button.
$("pullIndicator").append($("refresh").querySelector("svg").cloneNode(true));
setupPullToRefresh({
  indicator: $("pullIndicator"),
  isAllowed: () => !runtime.loading && cooldownLeft() <= 0,
  refresh,
  // No pull while the settings are open or before a station is chosen.
  ignore: () => !$("settings").hidden || settings.stations.length === 0,
});

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

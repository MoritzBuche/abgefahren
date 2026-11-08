// Calls the public transport.rest API directly from the browser. Both services
// allow this (CORS) and need no key, so the app works on any static web server.

const UPSTREAMS = ["https://v6.bvg.transport.rest", "https://v6.vbb.transport.rest"];
const UPSTREAM_TIMEOUT_MS = 6000; // per service

// Always fetched in full so the sliders can filter without a new request.
export const WINDOW_MINUTES = 40;

async function fetchWithTimeout(url, signal, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

// Tries the services in order and returns the first answer.
async function request(path, params, { signal, ...options } = {}) {
  const query = new URLSearchParams(params);
  let lastError;
  for (const base of UPSTREAMS) {
    try {
      return await fetchWithTimeout(`${base}${path}?${query}`, signal, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      console.warn(`${base} failed:`, error);
    }
  }
  throw lastError;
}

export async function searchStations(text, signal) {
  const items = await request(
    "/locations",
    { query: text, results: 8, stops: true, addresses: false, poi: false },
    { signal },
  );
  return items
    .filter((item) => item.id && item.location)
    .map((item) => ({
      id: item.id,
      name: item.name,
      lat: item.location.latitude,
      lon: item.location.longitude,
      products: Object.keys(item.products || {}).filter((name) => item.products[name]),
    }));
}

export async function getDepartures(stationId) {
  const data = await request(
    `/stops/${encodeURIComponent(stationId)}/departures`,
    // Without an explicit "results", the API cuts busy stations off after
    // roughly 50 departures, whatever the duration.
    { duration: WINDOW_MINUTES, results: 1000, remarks: false, linesOfStops: false },
    { cache: "no-store" },
  );
  return (data.departures || []).map((item) => ({
    tripId: item.tripId,
    stopId: item.stop?.id,
    when: item.when,
    planned: item.plannedWhen,
    delay: item.delay,
    cancelled: Boolean(item.cancelled),
    platform: item.platform || item.plannedPlatform,
    direction: item.direction,
    line: item.line?.name,
    product: item.line?.product,
    destLat: item.destination?.location?.latitude,
    destLon: item.destination?.location?.longitude,
  }));
}

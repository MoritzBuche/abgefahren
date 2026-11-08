// Works out whether a departure runs towards or away from the chosen reference
// point ("inward" means towards it).
//
// The transit API has no such field, so this is a geometric estimate: it
// compares the compass direction from the station to the destination with the
// direction from the station to the reference point.

export const CENTRES = {
  hbf: { label: "Hbf", name: "Hauptbahnhof", lat: 52.5251, lon: 13.3694 },
  alex: { label: "Alex", name: "Alexanderplatz", lat: 52.5215, lon: 13.4113 },
  zoo: { label: "Zoo", name: "Zoologischer Garten", lat: 52.5067, lon: 13.3325 },
};
export const DEFAULT_CENTRE = "hbf";

// A station this close is the reference point itself, including its bus stops.
const AT_CENTRE_KM = 0.5;
// Below this cosine (about 75 to 105 degrees) a trip runs past the reference
// point rather than towards or away from it, so distance decides instead.
const TANGENTIAL = 0.25;

function kmFromCentre(lat, lon, centre) {
  return {
    x: (lon - centre.lon) * 111.32 * Math.cos((centre.lat * Math.PI) / 180),
    y: (lat - centre.lat) * 110.57,
  };
}

export function isAtCentre(station, centre) {
  const p = kmFromCentre(station.lat, station.lon, centre);
  return Math.hypot(p.x, p.y) <= AT_CENTRE_KM;
}

function isRing(departure) {
  return /^ringbahn/i.test(departure.direction || "") || /^S4[12]$/.test(departure.line || "");
}

// Returns "inward", "outward", "ring" (circular line, neither direction) or
// "unknown" (the API gave no destination coordinates).
export function classify(station, departure, centre) {
  if (isRing(departure)) return "ring";
  if (departure.destLat == null || departure.destLon == null) return "unknown";
  if (isAtCentre(station, centre)) return "outward";

  const from = kmFromCentre(station.lat, station.lon, centre);
  const to = kmFromCentre(departure.destLat, departure.destLon, centre);
  const fromDistance = Math.hypot(from.x, from.y);
  const toDistance = Math.hypot(to.x, to.y);
  const tripX = to.x - from.x;
  const tripY = to.y - from.y;
  const tripLength = Math.hypot(tripX, tripY);
  if (tripLength === 0) return "outward";

  const cosine = (tripX * -from.x + tripY * -from.y) / (tripLength * fromDistance);
  if (cosine >= TANGENTIAL) return "inward";
  if (cosine <= -TANGENTIAL) return "outward";
  return toDistance < fromDistance ? "inward" : "outward";
}

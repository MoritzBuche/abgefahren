# Abgefahren – Berlin

Installable web app (PWA) showing live departures for your Berlin stations, in
German and English. Plain JavaScript and CSS, no build step and no backend: the
browser calls the transit API directly, so any static web server can host the
`docs` folder.

## How this app was made

This app was vibe coded: Claude, Anthropic's AI assistant (in Claude Code), wrote
the code. I came up with the idea and steered it step by step with instructions and
feedback, and made only a few small changes myself. So the credit for the code goes
to Claude; the idea is mine.

## Run

Any static web server works. For example:

```bash
python3 -m http.server 8000 --directory docs
```

Then open <http://localhost:8000>. Opening `index.html` directly as a file does not
work, because browsers block JavaScript modules and service workers there.

## Installing on a phone

Browsers only allow installation and offline mode on `localhost` or over HTTPS.
On your own network the app works as a normal website. To install it, host the
`docs` folder over HTTPS, for example with Caddy, Nginx, or a static host such as
GitHub Pages or Netlify.

## How it is built

| Part | Job |
| --- | --- |
| `docs/js/api.js` | Calls the transit API, with a second service as fallback |
| `docs/js/app.js` | State, refresh timing, filters, rendering |
| `docs/js/direction.js` | Inward/outward estimate |
| `docs/js/map.js` | OpenStreetMap minimap from plain tile images |
| `docs/js/i18n.js` | German and English text |
| `docs/js/icons.js` | Transport symbols and line colours, drawn in the style of Berlin signage (not official logo files) |
| `docs/js/pull.js` | Pull down to refresh on touch screens |
| `docs/sw.js` | Makes the app itself available offline |

Settings and the last departures are saved in the browser's `localStorage`. The
browser contacts transport.rest and OpenStreetMap directly, so those services see
the visitor's IP address and the requested stations or map area.

## Favorites

The star on a selected station saves it as a favorite. Favorites stay in the settings
after the station is removed from the departures, and one tap selects them again.
Tapping the star again removes the favorite.

## Walking time and leave time

In the settings, each selected station has a walking-time slider from 0 to 15
minutes: half-minute steps up to 5 minutes, whole minutes after that. Its departures then show when you have to leave, with a coloured stripe and
label: green with 3 or more minutes to spare, yellow below 3, orange to leave now,
and red when the departure can no longer be reached. Stations without a walking
time look as before.

## Refresh rules

- Automatic refresh on the first full minute at least 2 minutes after the last
  refresh, paused while the app is in the background. The countdown stands in
  brackets next to the last update time.
- Manual refresh at most once per 30 seconds, also across page reloads. The symbol
  is struck through and the button is disabled during the wait.
- On a phone, pulling down at the top of the list refreshes like the button. If
  it's too early, the round indicator shows the struck-through symbol and shakes.
- Opening the app, or returning to it after a refresh was missed, loads fresh data
  straight away, also between full minutes.
- Filters run in the browser and never cause a request.
- Adding a station loads only that station and doesn't start the timer.

## Inward/outward is an estimate

The transit API has no such field. In the settings you choose what "inward" means:
towards Hauptbahnhof (default), Alexanderplatz or Zoologischer Garten. The app
compares the direction from the station to the destination with the direction from
the station to that point. The places are defined in `docs/js/direction.js`.

- Stations within 500 m of the chosen point count everything as outward.
- Ring lines (S41, S42) are neither, so they only appear under "Both".
- It looks at the destination rather than the actual route, so a line that curves
  a lot, or a long-distance train, can be classified wrongly.

## Data sources

- Departures: [transport.rest](https://v6.bvg.transport.rest), a free community
  service without an uptime guarantee. This is not an official BVG app.
- Map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
  The public tile server suits personal use. A high-traffic deployment needs
  another tile provider under the
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

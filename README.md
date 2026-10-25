# YEG Bus

Live Edmonton Transit Service (ETS) bus and LRT arrivals to your stops. Live at [yegbus.com](https://yegbus.com).

- Save your stops, grouped by Home, School, Work or make your own. No account.
- Live countdowns from ETS's GPS feed, and the bus on a map with how many stops away it is.
- Pick the routes you ride and your walk time; it tells you when to leave, and adds a few minutes for snow or cold.
- Saved trips with a transfer say whether the change still works.
- No data: saved stops fall back to the scheduled timetable, with a button to text the stop to ETS's 31100.
- Turn a tablet sideways for a wall board. Android app with a home-screen widget in `android/`.

Not an official ETS app.

## How it fits together

| Part | What it does |
|---|---|
| `server/app.py` | One Python file, standard library plus the GTFS-realtime bindings. Imports the ETS GTFS schedule into SQLite nightly, polls trip updates, and vehicle positions every 10 s and alerts every 5 min, and serves a small JSON API under `/api/` plus the static web app. |
| `web/` | The web app: plain HTML, CSS and JavaScript, no build step. `sw.js` caches the app shell for offline starts; each saved stop keeps its own 30-hour timetable in `localStorage`. |
| `android/` | A WebView around yegbus.com plus a home-screen widget. Built with the bare SDK tools by `android/build.sh` (no Gradle). |
| `server/places.json` | Named places from OpenStreetMap so place search answers instantly. Rebuild with `scripts/places.sh`. |

Outside services, all free: ETS GTFS and GTFS-realtime (gtfs.edmonton.ca), City of Edmonton address data, [Photon](https://photon.komoot.io) for place search, [Open-Meteo](https://open-meteo.com) for weather, OpenStreetMap tiles and Leaflet (from cdnjs) for maps.

## Run it locally

Python 3.14 or newer.

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
PORT=8787 .venv/bin/python server/app.py   # first start downloads and imports the GTFS (a minute or two)
```

Then open http://localhost:8787. Step by step, including Docker: [docs/SETUP.md](docs/SETUP.md). Data goes to `data/` (set `DATA_DIR` to move it).

Or with Docker: `docker compose up -d --build` serves it on 127.0.0.1:8792.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests
```

CI runs the same on every push (`.github/workflows/test.yml`).

## Releasing and setup

[docs/SETUP.md](docs/SETUP.md) walks through all of it: how the site, the two API servers and Cloudflare Pages fit together, the version bump, shipping a release, rolling back, setting up a server or the Pages project from scratch, and building the signed Android app.

## Data and licence

Code: [GNU AGPL v3](LICENSE). If you run a changed version as a public service, share your changes.

Transit data: contains information licensed under the Open Government Licence - City of Edmonton. Map data: © OpenStreetMap contributors.

## Contact

support@yegbus.com

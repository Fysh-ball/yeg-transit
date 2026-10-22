# YEG Bus

Live Edmonton Transit Service (ETS) bus and LRT arrivals for the stops you use. Live at [yegbus.com](https://yegbus.com).

- Save your stops, grouped by Home, School, Work or your own names. No account.
- Live countdowns from ETS's GPS feed, and the bus on a map with how many stops away it is.
- Pick the routes you ride and your walk time; it tells you when to leave, and adds a few minutes for snow or cold.
- Saved trips with a transfer say whether the change still works.
- No data: saved stops fall back to the scheduled timetable, with a button to text the stop to ETS's 31100.
- Turn a tablet sideways for a wall board. Android app with a home-screen widget in `android/`.

Not an official ETS app.

## How it fits together

| Part | What it does |
|---|---|
| `server/app.py` | One Python file, standard library plus the GTFS-realtime bindings. Imports the ETS GTFS schedule into SQLite nightly, polls trip updates, vehicle positions and alerts every 30 s, and serves a small JSON API under `/api/` plus the static web app. |
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

Then open http://localhost:8787. Data goes to `data/` (set `DATA_DIR` to move it).

Or with Docker: `docker compose up -d --build` serves it on 127.0.0.1:8792.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests
```

CI runs the same on every push (`.github/workflows/test.yml`).

## Releasing

1. Commit your change. For any change under `web/`, bump the version everywhere: `yeg-vNN` in `web/sw.js` and every `?v=NN` in `web/*.html`, `web/app.js` and `web/sw.js`. Phones and Cloudflare keep the old files otherwise; `deploy.sh` refuses a mismatch.
2. Put `DEPLOY_HOST=user@host` and `DEPLOY_DIR=/path/to/compose/stack` in `scripts/deploy.conf` (gitignored).
3. Run `scripts/deploy.sh` from the repo root. It copies the code, builds the image, runs the tests inside it, starts it, and only says `landed` once the live site serves the new `sw.js` version and `/api/version` returns the commit you deployed.

## Android

`android/build.sh` builds `android/build/yeg-arrivals.apk` (needs the Android SDK build-tools 35 and platform 35); `android/build.sh install` puts it on a phone over adb. It signs with the SDK debug key, which is fine for sideloading but not for an app store.

## Data and licence

Code: [GNU AGPL v3](LICENSE). If you run a changed version as a public service, share your changes.

Transit data: contains information licensed under the Open Government Licence - City of Edmonton. Map data: © OpenStreetMap contributors.

## Contact

support@yegbus.com

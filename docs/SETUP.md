# Setup guide

How YEG Bus is put together, and how to set it all up again from this repo: run it on your
own computer, ship a release, add a server, and build the Android app. Every command runs from
the repo root unless it says otherwise.

## 1. What runs where

```
GitHub: main ──(push main:release)──> release ──> Cloudflare Pages ──> yegbus.com
                                                     │  web/ is the site
                                                     │  functions/api/ passes /api/* on
                                                     ▼
                       bus-pi.fysh.site (the Pi, main copy)  ──fails──>  bus.fysh.site (TrueNAS, fallback)
                       each one: Cloudflare Tunnel ──> 127.0.0.1:8792 ──> docker compose (this repo's Dockerfile)
```

- **`main`** is where work lands. CI (`.github/workflows/test.yml`) runs the tests on every push.
- **`release`** is what the public site serves. Cloudflare Pages rebuilds yegbus.com whenever
  it moves, so pushing `main` alone changes nothing people see.
- **The API servers** are the same Docker image on two machines. `scripts/deploy.sh` ships to one
  machine per run; `functions/api/[[path]].js` tries the Pi first and TrueNAS second, so either
  can go down without breaking the site. If both are down, phones still show their saved timetables.

## 2. Run it on your own computer

You need Git and Python 3.14 or newer.

```sh
git clone git@github.com:Fysh-ball/yeg-transit.git
cd yeg-transit
python -m venv .venv
.venv/bin/pip install -r requirements.txt
PORT=8787 .venv/bin/python server/app.py
```

The first start downloads the ETS timetable and imports it, which takes a minute or two. Then
open http://localhost:8787. Data goes to `data/` (set `DATA_DIR` to put it somewhere else).

You can use Docker instead: `docker compose up -d --build` serves it on http://127.0.0.1:8792.

Run the tests:

```sh
.venv/bin/python -m unittest discover -s tests
```

## 3. Day-to-day Git

- Work on `main`, or on a branch that you merge into `main`.
- Commit messages follow Conventional Commits: `type(scope): summary`, with a summary of 72
  characters or fewer. For example: `fix(web): no square ring around a tapped map pin (v84)`.
- **Bump the version on any change under `web/`.** Phones and Cloudflare keep the old files otherwise,
  and `deploy.sh` refuses a mismatch. The version is `yeg-vNN` in `web/sw.js` plus every `?v=NN`
  in `web/`. To go from 84 to 85:

  ```sh
  grep -rl "yeg-v84\|v=84" web/ | xargs sed -i 's/yeg-v84/yeg-v85/g; s/v=84/v=85/g'
  grep -rc "v84\|v=84" web/ | grep -v ':0'    # prints nothing when every copy changed
  ```

- Never commit `scripts/deploy*.conf`, `data/`, keys or passwords. `.gitignore` already covers the conf
  files and `data/`; the Android key lives outside the repo (section 6).

## 4. Ship a release

1. Commit to `main` with the version bumped and the tests passing, then push:
   `git push origin main`.
2. Deploy the API to both servers. Each run copies the code, builds the image, runs the tests
   inside it and starts it. It prints `landed` only once that server serves the new version
   and commit.

   ```sh
   scripts/deploy.sh                                     # TrueNAS, from scripts/deploy.conf
   DEPLOY_CONF=scripts/deploy-hermes.conf scripts/deploy.sh   # the Pi
   ```

3. Publish the site: `git push origin main:release`. The Cloudflare Pages build can take several minutes.
4. Check that it is live: `curl -s https://yegbus.com/sw.js | grep -o 'yeg-v[0-9]*'` must print the new
   version.
5. Check the times are right: `.venv/bin/python scripts/check_live.py` compares the live times on
   yegbus.com with ETS's own feed and must end `0 wrong`. It also runs every 15 minutes from a
   systemd user timer (`yeg-check.timer`, as `check_live.py --page`) and pops up a desktop
   notification: "YEG BUS TIMES WRONG" once per stop and route per 6 h, "yegbus.com unreachable"
   when the site or ETS didn't answer twice. The Pi runs the same check so it doesn't need the laptop on:
   `scripts/pi/` (deploy.sh copies it; install once with `sudo cp scripts/pi/*.service scripts/pi/*.timer
   /etc/systemd/system/ && sudo systemctl enable --now yeg-check.timer yeg-check-deadman.timer`). It sends
   wrong times to Lumi's app (the alert spool, via `scripts/pi/spool-notify`), and its dead-man sends one if no check has landed in 30 min. TrueNAS sends the
   same if the Pi itself is down: `scripts/pi/nas-watch.sh`, from TrueNAS cron job 57 (as Apollo, every 15 min).

Rolling back: every `deploy.sh` run prints a `rollback:` line, which restarts the previous image
(`yeg-transit:prev`) on that server. For the site, push the previous commit to `release`:
`git push -f origin <old-sha>:release`.

## 5. Set things up from scratch

### A server for the API

On any Linux machine with Docker:

1. Make a folder for the stack and copy `compose.yaml`, `Dockerfile` and `requirements.txt` into it. `deploy.sh` copies `server/` and `web/` on every run.
2. On your own computer, create `scripts/deploy.conf`. It is gitignored; for a second server, name it `deploy-<name>.conf`:

   ```sh
   DEPLOY_HOST=user@your-server        # ssh login
   DEPLOY_DIR=/path/to/the/stack       # the folder from step 1
   DEPLOY_DOCKER="sudo -n docker"      # only if that user is not in the docker group
   SITE=https://bus.example.com        # the public address deploy.sh checks
   ```

3. Publish it with a Cloudflare Tunnel: point a public hostname at `http://127.0.0.1:8792`. The
   container only listens on loopback, so the tunnel is the only way in.
4. Run `scripts/deploy.sh` (with `DEPLOY_CONF=...` for a second server).
5. Add the hostname to `ORIGINS` in `functions/api/[[path]].js` so the site can use it.

### The site on Cloudflare Pages

1. Cloudflare dashboard, Workers & Pages, Create, Pages, connect to Git, pick this repo.
2. Production branch: `release`. Framework preset: none. Build command: empty. Build output
   directory: `web`. Root directory: the repo root, so Pages finds `functions/` next to `web/`.
3. Add the custom domain (yegbus.com) under the project's Custom domains.
4. `web/_headers` sets the same security and cache headers the Python server sends; Pages
   picks it up on its own.

## 6. The Android app

The app is a WebView around yegbus.com plus a home-screen widget, built with the bare SDK tools (no Gradle).

1. Install the Android SDK with build-tools 35.0.0 and platform 35 under `~/Android/Sdk`, plus a JDK.
2. **Release key, once only.** Every update must be signed with the same key, or phones refuse to
   install it over the old app. Make it outside the repo and back up both files somewhere safe:

   ```sh
   mkdir -p ~/.config/yegbus && chmod 700 ~/.config/yegbus
   keytool -genkeypair -keystore ~/.config/yegbus/release.jks -alias yegbus \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=YEG Bus"
   # write the password you chose into ~/.config/yegbus/release.pass, then:
   chmod 600 ~/.config/yegbus/release.jks ~/.config/yegbus/release.pass
   ```

   `YEG_KEYSTORE=/other/path.jks` points the build at a key stored somewhere else; the password
   file sits next to it with `.pass` in place of `.jks`.

3. Build. `VERSION` must go up by one on every release you hand out:

   ```sh
   VERSION=2 android/build.sh            # writes android/build/yeg-arrivals.apk
   VERSION=2 android/build.sh install    # also installs it on a phone connected with adb
   ```

   The build stops if the key is missing or the APK ends up signed by a different key.

## 7. Refresh place search

`server/places.json` is a snapshot of named places from OpenStreetMap. To refresh it (needs `curl` and `jq`):

```sh
scripts/places.sh
```

Commit the new file, then ship a release.

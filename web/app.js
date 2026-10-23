// Saved stops live in localStorage on this phone; each keeps a cached timetable for offline use.
const KEY = "yeg.stops";
const $ = (s) => document.querySelector(s);
let stops = load();
// Android app moved from bus.fysh.site: that domain's storage stays behind, so take the stops back from the widget's copy.
if (!stops.length && window.YegApp && YegApp.stops) {
  try { stops = clean(JSON.parse(YegApp.stops())); } catch (e) { console.warn("widget stops:", e.message); }
}

function load() {
  try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch { return []; }
}
// Numbers stay numbers: a stop can arrive from a #move link or the widget, and walk and n are put in the page unescaped.
// A #move link can come from anyone, so cap the list and drop a route filter that isn't a list of names.
function clean(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.id === "string").slice(0, 50)
    .map((s) => ({ ...s, walk: Math.min(Math.max(Number(s.walk) || 0, 0), 60) || undefined, n: Number(s.n) || undefined,
      only: Array.isArray(s.only) && s.only.every((r) => typeof r === "string") ? s.only : undefined }));
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(stops)); } catch (e) { console.warn("save failed:", e.message); }
  // Ask the browser not to clear saved stops when space runs low (Chrome grants it quietly; Firefox asks once).
  // ponytail: iPhone Safari still clears a site after 7 days unvisited unless it's on the home screen; the tips say how.
  navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist()).catch((e) => console.warn("persist:", e.message));
  sync();
}
// Android app only: hand the stops (without their timetables) and the open tab to the home-screen widget.
function sync() {
  if (!window.YegApp) return;
  try {
    const slim = stops.map(({ id, code, name, group, lat, lon, only, walk, n }) => ({ id, code, name, group, lat, lon, only, walk, n }));
    window.YegApp.sync(JSON.stringify(slim), group || "");
    // The widget dresses like the app: "material-dark", "glass-light"... (apps before v54's widget lack look())
    const de = document.documentElement, t = de.dataset.theme;
    window.YegApp.look?.(de.dataset.look + (t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches) ? "-dark" : "-light"));
    window.YegApp.widget?.(localStorage.getItem("yeg.widget") || "card"); // apps before 1.20 lack widget()
  } catch (e) { console.warn("widget sync:", e.message); }
}

async function api(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch("/api/" + path, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error || ""}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ETS answers texts to 31100 for its own 4-digit stops; other agencies' stops have letter-prefixed ids.
const smsOk = (s) => /^\d+$/.test(s.id);
const smsLink = (s) => `sms:31100?&body=${encodeURIComponent(s.code)}`;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function clock(t) { return new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function mins(t, now) {
  const m = Math.round((t - now) / 60);
  return m <= 0 ? `<span class="due">Due</span>` : m < 60 ? `${m}<span class="u"> min</span>` : clock(t);
}

// ETS short names are zero-padded ("005") and headsigns repeat the number ("5 Coliseum").
function routeLabel(r) { return String(r).replace(/^0+(?=\w)/, ""); }
function headLabel(h, r) {
  const n = routeLabel(r);
  return h.startsWith(n + " ") ? h.slice(n.length + 1) : h;
}

// With a walk time set, the big number is when to leave, not when the bus comes.
function row(d, now, walk = 0, stopId = "") {
  const bg = "var(--accent)"; // one brand green, not ETS route colours, so nobody takes this for the official app
  const fg = "var(--accent-text)";
  const tag = d.live ? `<small class="live">live</small>` : `<small>scheduled</small>`;
  const when = walk && d.time - walk * 60 - now < 30 ? `<span class="due">Go now</span>` : mins(d.time - walk * 60, now);
  const map = d.live && d.trip ? ` data-trip="${esc(d.trip)}" data-stop="${esc(stopId)}" title="Show this bus on a map"` : "";
  return `<div class="dep"${map}><span class="route" style="background:${esc(bg)};color:${esc(fg)}">${esc(routeLabel(d.route))}</span>
    <span class="head">${esc(headLabel(d.headsign, d.route))}</span><span class="when">${when}${tag}</span></div>`;
}

// Per-stop settings, like the wall board's: only my routes, walk time, how many routes.
// One line per route and direction; tap it to list its buses, tap a live bus for the map.
const expanded = new Set(); // "stop|route|headsign" lines left open across refreshes
// Snow, rain or bitter cold add up to 3 min on top of every walk time you set (from /api/weather).
let wx = { extra: 0, why: "" };
const walkOf = (s) => (s.walk ? s.walk + wx.extra : 0);
async function loadWeather() {
  try { wx = await api("weather"); } catch (e) { console.warn("weather:", e.message); }
}
function grouped(s, list, now) {
  const walk = walkOf(s) * 60, groups = new Map();
  for (const d of list) {
    if ((s.only && !s.only.includes(d.route)) || (walk && d.time - walk < now)) continue;
    const key = `${s.id}|${d.route}|${d.headsign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const html = [...groups].slice(0, s.n || 3).map(([key, ds], i) => {
    const open = expanded.has(key);
    // The soonest bus leads: the first card on screen shows it big, with a wave that fills as the bus gets closer.
    const lead = (h) => i ? h : h.replace('class="dep', 'class="dep lead').replace(/<\/(div|button)>$/, wave(s, ds[0], now) + "</$1>");
    if (ds.length === 1) { // one bus: nothing to expand, the line itself opens the map
      const note = ds[0].live && ds[0].trip ? "no more soon \u00B7 tap for map" : "no more soon";
      return `<div class="grp">${lead(row(ds[0], now, walkOf(s), s.id).replace('</span><span class="when">', `<span class="then">${note}</span></span><span class="when">`))}</div>`;
    }
    const then = ds.slice(1, 3).map((d) => Math.max(0, Math.round((d.time - walk - now) / 60))).join(", ");
    const head = row(ds[0], now, walkOf(s)).replace(/^<div class="dep"[^>]*>/, `<button class="dep grp-head" data-expand="${esc(key)}" aria-expanded="${open}">`)
      .replace(/<\/div>$/, "</button>")
      .replace('</span><span class="when">', `<span class="then">${then ? `then ${then} min` : "no more soon"}</span></span><span class="when">`);
    return `<div class="grp">${lead(head)}<div class="grp-body"${open ? "" : " hidden"}>${ds[0].live && ds[0].trip ? `<button class="dep map-link" data-trip="${esc(ds[0].trip)}" data-stop="${esc(s.id)}">Next bus on map \u203A</button>` : ""}${ds.slice(1).map((d) => row(d, now, walkOf(s), s.id)
      .replace(/<span class="head">[^<]*<\/span>/, `<span class="head">${d.live && d.trip ? "Show on map \u203A" : "Scheduled, no map"}</span>`)).join("")}</div></div>`;
  }).join("");
  return html && `<div class="deps">${html}</div>`;
}

// Wave under the lead bus: full when it's time to go, filling over the last 15 minutes. Drawn by drawWaves().
function wave(s, d, now) {
  const m = (d.time - walkOf(s) * 60 - now) / 60;
  const f = Math.min(1, Math.max(0.04, 1 - m / 15));
  return `<svg class="wave" data-stop="${esc(s.id)}" data-f="${f.toFixed(3)}" viewBox="0 0 330 24" preserveAspectRatio="none" aria-hidden="true"><path class="track"/><path class="fill"/></svg>`;
}
// Big waves on the left shrink to flat at the tip, which runs into the track line. On arrival it fills, flattens,
// and the route badge bounces once. State per stop survives the 30 s re-render so the wave glides, not jumps.
const waves = new Map(), still = matchMedia("(prefers-reduced-motion: reduce)");
function drawWaves() {
  for (const svg of document.querySelectorAll(".stop:not([hidden]) .lead .wave")) {
    if (!svg.getClientRects().length) continue; // hidden by the look or the wall board
    const f = +svg.dataset.f, id = svg.dataset.stop, W = 330;
    const w = waves.get(id) || { cur: f, amp: f >= 1 ? 0 : 8, phase: 0, arrived: false };
    const k = still.matches ? 1 : 0.04;
    w.cur += (f - w.cur) * k;
    w.amp += ((f >= 1 ? 0 : 8) - w.amp) * (still.matches ? 1 : 0.08);
    w.phase += still.matches ? 0 : 0.045;
    if (f >= 1 && !w.arrived) { w.arrived = true; svg.closest(".dep").querySelector(".route").classList.add("arrive"); }
    if (f < 1) w.arrived = false;
    waves.set(id, w);
    const end = w.cur * W, pts = [];
    for (let x = 0; x <= end; x += 2.5) pts.push(`${x ? "L" : "M"}${x.toFixed(1)} ${(12 + w.amp * Math.pow(1 - x / end, 0.85) * Math.sin(x / 9 - w.phase)).toFixed(2)}`);
    pts.push(`L${end.toFixed(1)} 12`);
    svg.querySelector(".fill").setAttribute("d", pts.join(""));
    svg.querySelector(".track").setAttribute("d", end < W ? `M${end.toFixed(1)} 12H${W}` : "");
  }
  requestAnimationFrame(drawWaves);
}
requestAnimationFrame(drawWaves);
const editing = new Set();
let firstStop = null;
function settingsPanel(s) {
  const all = s.allRoutes || [];
  const chips = all.map((r) => `<button class="chip" aria-pressed="${!s.only || s.only.includes(r)}" data-route="${esc(r)}">${esc(routeLabel(r))}</button>`).join("");
  const opt = (vals, cur, f) => vals.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${f(v)}</option>`).join("");
  return `<div class="settings" data-stop="${esc(s.id)}">
    <div class="prefs-bar"><button class="icon-btn" type="button" data-settings="${esc(s.id)}" aria-label="Back" title="Back"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><h2>${esc(s.name)}<span class="sub">Stop #${esc(s.code)}</span></h2></div>
    ${s.id === firstStop ? `<p class="note">Pick the routes you ride and how long your walk is. Change it any time with the sliders button.</p>` : ""}
    ${all.length ? `<p class="label">Pick routes</p><div class="chips">${chips}</div>` : ""}
    <label>Walk to this stop <span><input type="number" data-set="walk" min="0" max="60" step="1" inputmode="numeric" value="${Number(s.walk) || 0}"> min</span></label>
    <label>Group <select data-set="group">${opt(["", ...new Set([...GROUPS, ...groupNames()]), "+"], s.group || "",
      (v) => esc(v === "" ? "None" : v === "+" ? "New group..." : v))}</select></label>
    <label>Buses to show <select data-set="n">${opt([3, 4, 5, 6, 8, 10], s.n || 3, String)}</select></label>
    ${all.length ? `<label>I change buses: ride <select data-set="ride">${opt(["", ...(s.only || all)], s.xfer?.route || "",
      (v) => (v ? esc(routeLabel(v)) : "No"))}</select></label>${s.xfer ? xferPicker(s) : ""}` : ""}
    <button class="primary" data-settings="${esc(s.id)}">Done</button></div>`;
}

// Saved transfer: ride s.xfer.route from this stop, change to s.xfer.to; the card says if the change still works.
const conns = new Map(); // "stop|route" -> places you can change, from /connections (this page load only)
function xferPicker(s) {
  const key = `${s.id}|${s.xfer.route}`, list = conns.get(key);
  if (!list) {
    conns.set(key, null);
    api(`stops/${encodeURIComponent(s.id)}/connections?route=${encodeURIComponent(s.xfer.route)}`)
      .then((l) => { conns.set(key, l); rerender(s.id); })
      .catch((e) => { conns.delete(key); console.warn("connections:", e.message); });
  }
  if (!list) return `<p class="note">Finding where you can change...</p>`;
  if (!list.length) return `<p class="note">No other routes to change to on this one.</p>`;
  const cur = list.findIndex((c) => c.route === s.xfer.to && c.headsign === s.xfer.headsign && c.at === s.xfer.at);
  return `<label>then change to <select data-set="xferTo"><option value="">Pick a route</option>${list.map((c, i) =>
    `<option value="${i}"${i === cur ? " selected" : ""}>${esc(routeLabel(c.route))} ${esc(headLabel(c.headsign, c.route))}, at ${esc(c.at_name)}${c.walk_m ? ` (${c.walk_m} m walk)` : ""}</option>`).join("")}</select></label>`;
}
function xferLine(s, x, now) {
  const walk = walkOf(s) * 60, t = x.trips.find((t) => t.time - walk >= now - 30);
  if (!t) return "";
  const to = `${esc(routeLabel(s.xfer.to))} ${esc(headLabel(s.xfer.headsign, s.xfer.to))}`;
  const lead = `${clock(t.time)} ${esc(routeLabel(s.xfer.route))}, change to ${to} at ${esc(s.xfer.at_name)}: `;
  const spare = Math.max(0, Math.round(t.slack / 60));
  const text = t.status === "on_track" ? `on track, ${spare} min to spare`
    : t.status === "tight" ? `tight, ${spare ? `${spare} min` : "under a minute"} to spare`
    : t.status === "missed" ? `likely missed. ${t.next ? `Next one at ${clock(t.next.time)}` : "No later one in the next 3 hours"}.`
    : `no ${esc(routeLabel(s.xfer.to))} in the next 3 hours.`;
  return `<p class="xfer ${t.status || "none"}">${lead}${text}</p>`;
}

async function refreshTimetable(s) {
  const tt = await api(`stops/${encodeURIComponent(s.id)}/timetable?hours=30`);
  s.tt = { to: tt.to, rows: tt.rows };
  save();
}

function offlineRows(s, now) {
  if (!s.tt) return null;
  return s.tt.rows.filter((r) => r[0] >= now - 30)
    .map(([time, route, headsign, color, text_color]) => ({ time, route, headsign, color, text_color, live: false }));
}

// ETS alerts for this stop (closed, moved, detoured), with one tap to save the stop they say to use instead.
function alertBox(s, alerts) {
  return alerts.map((a) => {
    const routes = a.routes.length ? `${a.routes.length > 1 ? "Routes" : "Route"} ${esc(a.routes.map(routeLabel).join(", "))}` : "";
    const until = a.until ? `until ${new Date(a.until * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
    const use = a.use.map((u) => {
      const saved = stops.some((x) => x.id === u.id);
      const add = { id: u.id, code: u.code, name: u.name, lat: u.lat, lon: u.lon, ...(s.group ? { group: s.group } : {}) };
      return `<button ${saved ? "disabled" : ""} data-add='${esc(JSON.stringify(add))}'>${saved ? "Saved" : "Add"} #${esc(u.code)} ${esc(u.name)}</button>`;
    }).join("");
    return `<div class="alert"><b>${esc(a.head)}</b>${routes || until ? `<span class="sub">${[routes, until].filter(Boolean).join(" &middot; ")}</span>` : ""}
      <p>${esc(a.text)}</p>${use}</div>`;
  }).join("");
}

function stopHead(s) {
  const walk = s.walk ? ` &middot; times show when to leave (${s.walk} min walk${wx.extra ? ` + ${wx.extra} for ${esc(wx.why)}` : ""})` : "";
  return `<div class="stop-head"><h2>${esc(s.name)}<span class="sub">Stop #${esc(s.code)}${s.where ? ` &middot; ${esc(s.where)}` : ""}${walk}</span></h2>
    <button class="icon-btn" data-settings="${esc(s.id)}" aria-label="Settings for ${esc(s.name)}" title="Settings" aria-expanded="${editing.has(s.id)}">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
    </button>
    <button class="icon-btn" data-remove="${esc(s.id)}" aria-label="Remove ${esc(s.name)}" title="Remove">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button></div>`;
}

async function renderStop(s, el) {
  const now = Math.floor(Date.now() / 1000);
  let body, offline = false;
  try {
    const x = s.xfer?.to && api(`stops/${encodeURIComponent(s.id)}/transfer?` + new URLSearchParams(
      { route: s.xfer.route, off: s.xfer.off, at: s.xfer.at, to: s.xfer.to, walk_m: s.xfer.walk_m }))
      .catch((e) => console.warn("transfer:", e.message));
    const d = await api(`stops/${encodeURIComponent(s.id)}/departures?n=30`);
    if (d.stop.routes) s.allRoutes = d.stop.routes.split(",");
    Object.assign(s, { lat: d.stop.lat, lon: d.stop.lon, where: d.stop.where }); // nearest group; which kerb
    save();
    const xf = await x;
    body = alertBox(s, d.alerts || []) + (xf ? xferLine(s, xf, d.now) : "") +
      (grouped(s, d.departures, d.now) || `<p class="note">No ${s.only ? "buses on your routes" : "departures"} in the next 3 hours.</p>`);
    el.dataset.live = now;
    if (!s.tt || s.tt.to - now < 12 * 3600) refreshTimetable(s).catch((e) => console.warn("timetable:", e.message));
  } catch (e) {
    if (e.message.startsWith("404")) { // dropped from the ETS schedule: old saved times would send people to a dead stop
      body = `<div class="alert"><b>ETS no longer lists this stop.</b> It may have closed or been renumbered.
        ${s.lat ? `<button data-near-stop="${esc(s.id)}">Stops near here</button>` : ""}</div>`;
      el.innerHTML = stopHead(s) + body;
      return;
    }
    offline = true;
    console.warn("live fetch failed:", e.message);
    const rows = offlineRows(s, now);
    body = (rows && grouped(s, rows, now)) || `<p class="note">No saved timetable for this stop yet.</p>`;
    body += `<p class="note">Scheduled times only. Buses may be early or late.</p>`;
  }
  if (offline && smsOk(s)) body += `<a class="sms" href="${smsLink(s)}">Text ${esc(s.code)} to 31100 for live times</a>`;
  const was = el.querySelector(".lead .when")?.firstChild?.textContent;
  el.innerHTML = stopHead(s) + (editing.has(s.id) ? settingsPanel(s) : "") + body;
  el.classList.toggle("editing", editing.has(s.id));
  const now2 = el.querySelector(".lead .when");
  if (was && now2 && now2.firstChild?.textContent !== was) now2.classList.add("tick"); // the new minute rolls in
  return offline;
}

async function renderAll() {
  const main = $("#stops");
  renderTabs();
  $("#empty").hidden = stops.length > 0;
  if (!stops.length) $("#tips").hidden = true;
  [...main.children].forEach((c) => { if (!stops.some((s) => s.id === c.dataset.id)) c.remove(); });
  const results = await Promise.all(stops.map((s) => {
    let el = main.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
    if (el && editing.has(s.id)) return false; // a 30 s refresh would close an open picker
    if (!el) {
      el = document.createElement("section"); el.className = "stop"; el.dataset.id = s.id;
      el.innerHTML = stopHead(s) + `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
      main.append(el);
    }
    el.hidden = !!group && s.group !== group;
    el.classList.toggle("walk", !!s.walk); // walk time set: the card leads with when to leave
    return renderStop(s, el);
  }));
  const off = results.some(Boolean);
  $("#offline").hidden = !off;
  $("#offline").textContent = !off ? "" : navigator.onLine ? "Live times are down right now. Showing saved scheduled times instead." : "No connection. Showing saved scheduled times instead of live times.";
  $("#updated").textContent = stops.length && !off ? `Live times, updated ${clock(Date.now() / 1000)}` : "";
}

// Walk minutes from straight-line metres: streets add about a third, people walk about 80 m a minute,
// plus 2 min to spare (lights, getting out the door): better early than watching the bus pull away.
const walkMin = (m) => Math.round((m * 1.3) / 80) + 2;
// Straight-line metres, good enough to rank stops a few hundred metres away.
function metres(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180) * 111320;
  return Math.round(Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * k));
}

let here = null; // last "near me" fix; ranks typed results closest first

function stopItems(list, from, numbered = false) {
  return list.map((s, i) => {
    const routes = s.routes ? ` &middot; ${s.routes.includes(",") ? "Routes" : "Route"} ${esc(s.routes.split(",").map(routeLabel).join(", "))}` : "";
    const walk = from && walkMin(metres(from, s));
    const sub = `Stop #${esc(s.code)}${routes}${walk ? ` &middot; about ${walk} min walk` : ""}${s.alert ? `<b class="flag">${esc(s.alert)}</b>` : ""}`;
    const saved = stops.some((x) => x.id === s.id);
    const add = { id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon, ...(walk && walk <= 60 ? { walk } : {}) };
    return `<li data-n="${i + 1}">${numbered ? `<span class="num">${i + 1}</span>` : ""}<span class="grow">${esc(s.name)}<span class="sub">${sub}</span></span>
     <button ${saved ? "disabled" : ""} data-add='${esc(JSON.stringify(add))}'>${saved ? "Saved" : "Add"}</button></li>`;
  }).join("");
}
function showResults(list, from, title) {
  $("#results").innerHTML = (title ? `<li class="group">${esc(title)}</li>` : "") +
    (list.length ? stopItems(list, from) : "<li>No stops found. Check the number on the stop sign.</li>");
}
function showMixed(list, places, q = "") {
  const p = places.map((x) => `<li class="pick" data-place='${esc(JSON.stringify(x))}' role="button" tabindex="0">
     <span class="grow">${esc(x.name)}<span class="sub">${esc(x.sub)}</span></span><span class="go" aria-hidden="true">\u203A</span></li>`).join("");
  // A bare number could be a stop or a house: say what else to type instead of looking broken.
  const more = /^\d+[a-z]?$/i.test(q) ? `<li class="note-row">House number? Keep typing the street, like ${esc(q)} 103 St.</li>` : "";
  $("#results").innerHTML = (list.length ? `<li class="group">Stops</li>` + stopItems(list.slice(0, 8), here) : "") +
    (p ? `<li class="group">${more ? "Nearest addresses with this number" : "Addresses and places"}</li>` + p : "") + more || "<li>Nothing found yet. Try a street, a place, or the stop number.</li>";
}

// Suggestions as you type: stop names and numbers from GTFS, places from OpenStreetMap.
let seq = 0, timer = 0;
async function suggest(q) {
  const n = ++seq;
  const at = here ? `&lat=${here.lat}&lon=${here.lon}` : "";
  const stopsP = api(`stops/search?q=${encodeURIComponent(q)}${at}`);
  // Places twice: our own list of shops, schools and landmarks answers at once; Photon (streets, areas) adds more after.
  const placesP = (path) => q.length < 3 ? Promise.resolve([])
    : api(`${path}?q=${encodeURIComponent(q)}${at}`).catch((e) => { console.warn(path + ":", e.message); return []; });
  const localP = placesP("places/local"), photonP = placesP("places");
  try {
    const [list, local] = await Promise.all([stopsP, localP]);
    if (n !== seq) return;
    showMixed(list, local, q);
    const seen = new Set(local.map((p) => p.name.toLowerCase()));
    const more = (await photonP).filter((p) => !seen.has(p.name.toLowerCase()));
    if (n === seq && more.length) showMixed(list, [...local, ...more].slice(0, 8), q);
  } catch (err) { if (n === seq) $("#results").innerHTML = `<li>Search needs a connection (${esc(err.message)}).</li>`; }
}
// Stops around you or an address: a map with numbered pins over the same numbered list.
const PINS = 8;
let nearMap = null;
async function nearby(from, title, you = false) {
  let list;
  try { list = await api(`stops/near?lat=${from.lat}&lon=${from.lon}`); }
  catch (err) { $("#results").innerHTML = `<li>Needs a connection (${esc(err.message)}).</li>`; return; }
  if (!list.length) return showResults([], from, title);
  list = list.slice(0, PINS);
  $("#results").innerHTML = `<li class="group">${esc(title)}</li><li class="near-map"><div id="near-map"></div></li>` + stopItems(list, from, true);
  try { await loadLeaflet(); } catch (e) { $(".near-map").textContent = `Map unavailable: ${e.message}`; return; }
  if (!$("#near-map")) return; // the list changed while the map library loaded
  if (nearMap) nearMap.remove();
  nearMap = L.map("near-map", { zoomControl: false, attributionControl: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(nearMap);
  L.circleMarker([from.lat, from.lon], { radius: 8, color: "#fff", weight: 3, fillColor: you ? "#17694a" : "#d93025", fillOpacity: 1 })
    .bindTooltip(you ? "You" : esc(from.name || "Here")).addTo(nearMap);
  // Tap a pin: a card naming the stop, with Add (pins sit close together, so no add on the first tap).
  const items = $("#results").querySelectorAll("li[data-n]");
  list.forEach((s, i) => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", iconSize: [30, 30], html: `<span class="stop-pin">${i + 1}</span>` }) })
    .bindPopup(`<div class="pin-card"><b>${i + 1}. ${esc(s.name)}</b>${items[i].querySelector(".sub").outerHTML}${items[i].querySelector("button").outerHTML}</div>`,
      { closeButton: false, minWidth: 200 })
    .addTo(nearMap));
  nearMap.fitBounds(L.latLngBounds([[from.lat, from.lon], ...list.map((s) => [s.lat, s.lon])]).pad(0.15), { maxZoom: 18 });
}

function setAdd(open, focus = true) {
  $("#add").hidden = !open;
  $("#add-btn").setAttribute("aria-expanded", String(open));
  $("#add-btn").textContent = open ? "Close" : "+ Add stop";
  if (open) { if (focus) $("#q").focus(); } else { $("#results").innerHTML = ""; $("#q").value = ""; }
}

$("#add-btn").onclick = () => setAdd($("#add").hidden);
// Settings is its own page: a history entry, so the phone's back button closes it.
function setPrefs(open) {
  if ($("#prefs").hidden === !open) return;
  $("#prefs").hidden = !open;
  $("#prefs-btn").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("in-prefs", open);
  if (open) { history.pushState({ prefs: 1 }, ""); scrollTo(0, 0); }
}
$("#prefs-btn").onclick = () => setPrefs(true);
$("#prefs-back").onclick = () => (history.state?.prefs ? history.back() : setPrefs(false));
addEventListener("popstate", () => { setPrefs(false); setEdit(null); });
// A stop's settings are a page of their own too, never a form inside its coloured card.
function setEdit(id) {
  const was = [...editing][0];
  if (was === id) return;
  editing.clear();
  if (id) editing.add(id);
  document.body.classList.toggle("in-edit", !!id);
  if (was) { if (was === firstStop) { firstStop = null; showTips(); } rerender(was); }
  if (id) { history.pushState({ edit: id }, ""); scrollTo(0, 0); rerender(id); }
}
$("#results").onkeydown = (e) => { if (e.key === "Enter" && e.target.matches(".pick")) e.target.click(); };

$("#q").oninput = () => {
  clearTimeout(timer);
  const q = $("#q").value.trim();
  if (q.length < 2) { seq++; $("#results").innerHTML = ""; return; }
  timer = setTimeout(() => suggest(q), 300);
};
$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  clearTimeout(timer);
  const q = $("#q").value.trim();
  if (q) suggest(q);
  $("#q").blur(); // drop the keyboard so the results show
};

$("#near").onclick = () => {
  if (!navigator.geolocation) { $("#results").innerHTML = "<li>Type your address or the stop number.</li>"; return $("#q").focus(); }
  $("#results").innerHTML = "<li>Finding you...</li>";
  navigator.geolocation.getCurrentPosition(
    (p) => { here = { lat: p.coords.latitude, lon: p.coords.longitude }; nearby(here, "Closest to you", true); },
    (err) => { // no location: straight to typing a home address or stop number
      $("#results").innerHTML = `<li>Couldn't get your location (${esc(err.message)}). Type your address or the stop number instead.</li>`;
      $("#q").focus();
    },
    { timeout: 10000, maximumAge: 60000 });
};

document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) {
    const s = JSON.parse(add.dataset.add);
    if (!stops.length) { firstStop = s.id; setEdit(s.id); } // onboarding: straight into its settings
    if (!stops.some((x) => x.id === s.id)) { stops.push(s); save(); }
    setAdd(false);
    renderAll();
    refreshTimetable(s).catch((err) => console.warn("timetable:", err.message));
  }
  const gone = e.target.closest("[data-near-stop]");
  if (gone) { const s = stops.find((x) => x.id === gone.dataset.nearStop); setAdd(true, false); nearby(s, `Closest to ${s.name}`); }
  const place = e.target.closest("[data-place]");
  if (place) { const x = JSON.parse(place.dataset.place); nearby(x, `Closest to ${x.name}`); }
  const grp = e.target.closest("[data-expand]");
  if (grp) {
    const key = grp.dataset.expand, open = !expanded.has(key);
    open ? expanded.add(key) : expanded.delete(key);
    grp.setAttribute("aria-expanded", String(open));
    grp.nextElementSibling.hidden = !open;
  }
  const dep = e.target.closest(".dep[data-trip]");
  if (dep) openMap(dep);
  const gear = e.target.closest("[data-settings]");
  if (gear) {
    const id = gear.dataset.settings;
    if (!editing.has(id)) setEdit(id);
    else if (history.state?.edit) history.back(); // popstate closes it, so the phone's back button and ours match
    else setEdit(null);
  }
  const chip = e.target.closest("[data-route]");
  if (chip) {
    const s = stops.find((x) => x.id === chip.closest(".settings").dataset.stop);
    const r = chip.dataset.route, all = s.allRoutes;
    const only = (s.only || all).includes(r) ? (s.only || all).filter((x) => x !== r) : [...s.only, r];
    s.only = only.length && only.length < all.length ? only : null; // none or all picked means show everything
    save(); rerender(s.id);
  }
  const rm = e.target.closest("[data-remove]");
  if (rm) { stops = stops.filter((x) => x.id !== rm.dataset.remove); save(); renderAll(); }
});

document.addEventListener("change", (e) => {
  const k = e.target.dataset.set;
  if (!k) return;
  const s = stops.find((x) => x.id === e.target.closest(".settings").dataset.stop);
  if (k === "group") {
    let g = e.target.value;
    if (g === "+") g = (prompt("Name this group, like Gym or Mom's") || "").trim().slice(0, 20) || s.group || "";
    s.group = g || undefined;
    if (group) group = s.group || null; // follow the stop so it doesn't vanish mid-edit
    save(); rerender(s.id); showGroup();
    return;
  }
  if (k === "ride") {
    s.xfer = e.target.value ? { route: e.target.value } : undefined;
    save(); rerender(s.id);
    return;
  }
  if (k === "xferTo") {
    const c = conns.get(`${s.id}|${s.xfer.route}`)?.[e.target.value];
    s.xfer = c ? { route: s.xfer.route, to: c.route, headsign: c.headsign, off: c.off, at: c.at, at_name: c.at_name, walk_m: c.walk_m }
      : { route: s.xfer.route };
    save(); rerender(s.id);
    return;
  }
  s[k] = k === "walk" ? Math.min(60, Math.max(0, Math.round(Number(e.target.value) || 0))) : Number(e.target.value);
  save(); rerender(s.id);
});
function rerender(id) {
  const s = stops.find((x) => x.id === id), el = $("#stops").querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (s && el) renderStop(s, el);
}

// Groups (Home, School, Work, or your own): tabs over the stops; opens on the group with a stop nearest you.
const GROUPS = ["Home", "School", "Work"];
let group = null, groupPicked = 0; // null shows all; groupPicked is when a tab was last tapped
function groupNames() {
  const rank = (g) => (GROUPS.indexOf(g) + 1) || 99;
  return [...new Set(stops.map((s) => s.group).filter(Boolean))].sort((a, b) => rank(a) - rank(b));
}
function renderTabs() {
  const g = groupNames();
  if (group && !g.includes(group)) group = null;
  $("#groups").hidden = !g.length;
  $("#groups").innerHTML = [...g, ""].map((x) =>
    `<button class="chip" aria-pressed="${(x || null) === group}" data-group="${esc(x)}">${esc(x || "All")}</button>`).join("");
}
function showGroup() {
  renderTabs();
  sync();
  for (const el of $("#stops").children) el.hidden = !!group && stops.find((s) => s.id === el.dataset.id)?.group !== group;
}
function nearestGroup() {
  if (!groupNames().length || !navigator.geolocation || Date.now() - groupPicked < 10 * 60000) return;
  navigator.geolocation.getCurrentPosition((p) => {
    const me = { lat: p.coords.latitude, lon: p.coords.longitude };
    const near = stops.filter((s) => s.group && s.lat).sort((a, b) => metres(me, a) - metres(me, b))[0];
    if (near && near.group !== group) { group = near.group; showGroup(); }
  }, (e) => console.warn("location:", e.message), { timeout: 8000, maximumAge: 5 * 60000 });
}
$("#groups").onclick = (e) => {
  const b = e.target.closest("[data-group]");
  if (b) { group = b.dataset.group || null; groupPicked = Date.now(); showGroup(); }
};

// Bus map: tap a live bus. Leaflet loads on first use; the position refreshes every 15 s while open.
let mapState = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.crossOrigin = "anonymous"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
  css.integrity = "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==";
  document.head.append(css);
  return new Promise((ok, fail) => {
    const js = document.createElement("script");
    js.crossOrigin = "anonymous"; js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.integrity = "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==";
    js.onload = ok; js.onerror = () => fail(new Error("map library did not load"));
    document.head.append(js);
  });
}
async function openMap(dep) {
  const s = stops.find((x) => x.id === dep.dataset.stop);
  const g = dep.closest(".grp")?.querySelector(".grp-head") || dep; // rows inside a group carry no route or headsign
  const label = g.querySelector(".route"), head = g.querySelector(".head").firstChild.textContent;
  $("#map-title").innerHTML = `Route ${esc(label.textContent)} to ${esc(head)}<span class="sub">${esc(s ? s.name : "")}</span>`;
  $("#map-note").textContent = "Finding the bus...";
  $("#map-sheet").showModal();
  try { await loadLeaflet(); } catch (e) { $("#map-note").textContent = `Map unavailable: ${e.message}`; return; }
  if (!mapState) {
    const map = L.map("map-box", { zoomControl: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    mapState = { map, layer: L.layerGroup().addTo(map), timer: 0 };
  }
  const m = mapState;
  m.trip = dep.dataset.trip; m.stop = s; m.style = label.getAttribute("style"); m.fitted = false;
  m.label = label.textContent; m.bus = null; m.at = null; m.others = L.layerGroup();
  m.layer.clearLayers(); m.others.addTo(m.layer);
  m.map.invalidateSize();
  if (s && s.lat) m.map.setView([s.lat, s.lon], 15);
  // The route line first, under everything; a missing shape only costs the line.
  m.pts = null; m.color = getComputedStyle(label).backgroundColor; m.line = L.layerGroup().addTo(m.layer);
  api(`trips/${encodeURIComponent(m.trip)}/shape`).then((pts) => {
    if (m.trip !== dep.dataset.trip || !pts.length) return;
    m.pts = pts;
    drawLine();
  }).catch((e) => console.warn("route line:", e.message));
  if (s && s.lat) L.circleMarker([s.lat, s.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#17694a", fillOpacity: 1 })
    .bindTooltip("Your stop").addTo(m.layer);
  await placeBus();
  clearInterval(m.timer);
  m.timer = setInterval(placeBus, 15000);
}
// Slide the bus to its new spot over 2 s instead of jumping, like the big apps do.
function glide(marker, to) {
  const from = marker.getLatLng(), t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 2000);
    marker.setLatLng([from.lat + (to[0] - from.lat) * k, from.lng + (to[1] - from.lng) * k]);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// The route line: dots where the bus has been, solid where it still goes. Split at the shape point nearest the bus.
// ponytail: nearest point can pick the wrong pass on a route that doubles back on itself; the stop sequence would fix it.
function drawLine() {
  const m = mapState;
  if (!m.pts) return;
  let cut = 0;
  if (m.at && !m.at.before) {
    let best = Infinity;
    m.pts.forEach(([la, lo], i) => { const d = (la - m.at.lat) ** 2 + (lo - m.at.lon) ** 2; if (d < best) { best = d; cut = i; } });
  }
  m.line.clearLayers();
  const style = { color: m.color, weight: 5, opacity: 0.75 };
  if (cut > 0) L.polyline(m.pts.slice(0, cut + 1), { ...style, color: "#9aa0a6", opacity: 0.9, dashArray: "1 10", lineCap: "round" }).addTo(m.line);
  L.polyline(m.pts.slice(cut), style).addTo(m.line);
  m.line.eachLayer((l) => l.bringToBack());
}
async function placeBus() {
  const m = mapState, s = m.stop, trip = m.trip;
  try {
    const v = await api(`trips/${encodeURIComponent(trip)}${s ? `?stop=${encodeURIComponent(s.id)}` : ""}`);
    if (m.trip !== trip) return; // another bus was opened meanwhile
    m.at = v;
    drawLine();
    if (m.bus) glide(m.bus, [v.lat, v.lon]);
    else m.bus = L.marker([v.lat, v.lon], { zIndexOffset: 1000, icon: L.divIcon({ className: "", iconSize: [34, 34],
      html: `<span class="bus-pin" style="${esc(m.style)}">${esc(m.label)}</span>` }) }).addTo(m.layer);
    m.others.clearLayers();
    for (const o of v.others) L.marker(o, { interactive: false, icon: L.divIcon({ className: "", iconSize: [22, 22],
      html: `<span class="bus-pin other" style="${esc(m.style)}">${esc(m.label)}</span>` }) }).addTo(m.others);
    if (!m.fitted) { m.map.setView([v.lat, v.lon], 16); m.fitted = true; } // open zoomed in on the bus; the stop view is only the wait
    const away = v.before ? "Finishing its run before yours, then it comes to you. " : v.waiting ? "Hasn't started its trip yet. " : v.stops_away === undefined ? "" : v.stops_away === null ? "Already past your stop. "
      : v.stops_away === 0 ? "Your stop is next. " : `${v.stops_away} stop${v.stops_away > 1 ? "s" : ""} away. `;
    $("#map-note").textContent = `${away}Position ${v.age < 90 ? `${v.age} s` : `${Math.round(v.age / 60)} min`} old, updates every 15 s.`;
  } catch (e) {
    if (m.trip !== trip) return;
    $("#map-note").textContent = e.message.startsWith("404") ? "This bus hasn't sent its position yet. It may not have started its trip." : `Can't get the bus position (${e.message}).`;
  }
}
function closeMap() { if (mapState) clearInterval(mapState.timer); $("#map-sheet").close(); }
$("#map-close").onclick = closeMap;
$("#map-sheet").addEventListener("close", () => mapState && clearInterval(mapState.timer));
$("#map-sheet").addEventListener("click", (e) => { if (e.target.id === "map-sheet") closeMap(); }); // tap the backdrop

// Onboarding: the empty screen offers the two ways in; tips show once, after the first stop's settings.
$("#ob-near").onclick = () => { setAdd(true, false); $("#near").click(); };
// In the Android app the page is already installed: point at the widget instead of the browser's install menu.
if (window.YegApp) $("#tip-handy").innerHTML = "<b>Widget:</b> hold your home screen &rarr; <b>Widgets</b> &rarr; <b>YEG Bus</b>.";
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("#install").hidden = false; });
// The Android app's floating add button slides away while you scroll down and comes back on the way up.
let lastY = 0;
addEventListener("scroll", () => { document.body.classList.toggle("down", scrollY > lastY && scrollY > 80); lastY = scrollY; }, { passive: true });
function showTips() {
  try { if (localStorage.getItem("yeg.tips")) return; } catch { /* storage blocked: show them */ }
  $("#tips").hidden = false;
}
$("#tips-ok").onclick = () => {
  $("#tips").hidden = true;
  try { localStorage.setItem("yeg.tips", "1"); } catch (e) { console.warn("tips:", e.message); }
};
$("#install").onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null; $("#tips-ok").click();
};

// Theme: "" follows the phone, otherwise forced light or dark (applied before paint by index.html).
$("#theme").value = document.documentElement.dataset.theme || "";
$("#theme").onchange = (e) => {
  const t = e.target.value;
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem("yeg.theme", t) : localStorage.removeItem("yeg.theme"); } catch (err) { console.warn("theme:", err.message); }
  sync(); // the widget follows
};
// Look: "" follows the phone (glass on iPhone, Material elsewhere; setLook is in index.html so it applies before paint).
try { $("#look").value = localStorage.getItem("yeg.look") || ""; } catch { /* storage blocked: Match phone */ }
$("#look").onchange = (e) => {
  setLook(e.target.value);
  try { e.target.value ? localStorage.setItem("yeg.look", e.target.value) : localStorage.removeItem("yeg.look"); } catch (err) { console.warn("look:", err.message); }
  sync(); // the widget follows
};
// A computer has no "phone" and isn't turned sideways: say "system", and the wall board is just on or off.
if (!window.YegApp && matchMedia("(hover: hover) and (pointer: fine)").matches && !navigator.maxTouchPoints) {
  for (const o of document.querySelectorAll('#look option[value=""], #theme option[value=""]')) o.textContent = "Match system";
  $('#board-mode option[value="auto"]').hidden = true;
}

// Widget: the app's card, or clear with a ring (sample 9 D). Only apps from 1.20 have the bridge for it.
if (window.YegApp?.widget) $("#widget-row").hidden = false;
try { $("#widget").value = localStorage.getItem("yeg.widget") || "card"; } catch { /* storage blocked: card */ }
$("#widget").onchange = (e) => {
  try { localStorage.setItem("yeg.widget", e.target.value); } catch (err) { console.warn("widget:", err.message); }
  sync();
};

// Wall board: big type, clock, screen kept awake. On with #board, or when a touch device is turned
// sideways (laptops are landscape too, so pointer:coarse keeps them in the normal view).
const sideways = matchMedia("(orientation: landscape) and (pointer: coarse)");
let wakeLock = null;
// Wall board setting: "auto" (sideways), "on", "off". Exit turns it off until the phone is upright again.
let boardMode = "auto", boardExited = false;
try { boardMode = localStorage.getItem("yeg.board") || "auto"; } catch { /* storage blocked: default */ }
const isBoard = () => !boardExited && (location.hash === "#board" || boardMode === "on" || (boardMode === "auto" && sideways.matches));
async function wake() {
  if (!isBoard() || !navigator.wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { console.warn("wake lock:", e.message); }
}
function tick() { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); checkStale(); }
// A tab left open can fall behind (a sleeping laptop, a frozen tab, a stop's settings left open, a new release):
// say so where it shows, the wall board included, instead of passing old times off as live.
let newVersion = false, firstSha = null;
function checkStale() {
  const at = [...$("#stops").children].filter((c) => !c.hidden && c.dataset.live).map((c) => +c.dataset.live);
  const old = at.length && $("#offline").hidden && Date.now() / 1000 - Math.min(...at) > 90;
  $("#stale").hidden = !old && !newVersion;
  $("#stale span").textContent = newVersion ? "New version ready" : old ? `Times may be out of date (last live ${clock(Math.min(...at))}).` : "";
}
async function checkVersion() {
  try {
    const { sha } = await api("version");
    firstSha ??= sha;
    if (sha === firstSha) return;
    if (isBoard()) return location.reload(); // nobody is there to tap Refresh on a wall board
    newVersion = true; checkStale();
  } catch (e) { console.warn("version:", e.message); }
}
$("#stale-reload").onclick = () => location.reload();
function applyBoard() {
  const on = isBoard();
  document.body.classList.toggle("board", on);
  if (on) { setAdd(false); setPrefs(false); setEdit(null); wake(); } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
tick(); setInterval(tick, 10000);
sideways.addEventListener("change", () => { if (!sideways.matches) boardExited = false; applyBoard(); });
$("#board-exit").onclick = () => {
  boardExited = true;
  if (boardMode === "on") { // "Always" would bring it straight back on reload
    boardMode = "auto"; $("#board-mode").value = "auto";
    try { localStorage.setItem("yeg.board", "auto"); } catch (err) { console.warn("board:", err.message); }
  }
  if (location.hash === "#board") history.replaceState(null, "", location.pathname + location.search);
  applyBoard();
};
$("#board-mode").value = boardMode === "auto" && $('#board-mode option[value="auto"]').hidden ? "off" : boardMode; // a computer: "sideways" is off
$("#board-mode").onchange = (e) => {
  boardMode = e.target.value; boardExited = false;
  try { localStorage.setItem("yeg.board", boardMode); } catch (err) { console.warn("board:", err.message); }
  applyBoard();
};
window.addEventListener("hashchange", applyBoard);
applyBoard();

// Google auto ads: side rails on computers, a bottom banner on phones (formats are set in the AdSense dashboard).
// Never in the Android app (AdSense in a plain WebView breaks Google's rules) or on the wall board.
if (!window.YegApp && !isBoard()) {
  const ad = document.createElement("script");
  ad.async = true; ad.crossOrigin = "anonymous";
  ad.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7605167409778469";
  ad.onerror = () => console.warn("ads: script blocked or offline");
  document.head.append(ad);
}

renderAll();
loadWeather().then(() => wx.extra && renderAll());
nearestGroup();
setInterval(() => { if (!document.hidden) renderAll(); }, 30000);
setInterval(loadWeather, 15 * 60000);
checkVersion(); setInterval(checkVersion, 10 * 60000);
window.addEventListener("pageshow", (e) => e.persisted && renderAll()); // back from the browser's page cache
document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderAll(); wake(); nearestGroup(); } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=63").catch((e) => console.warn("sw:", e.message));

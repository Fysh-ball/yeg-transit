// Saved stops live in localStorage on this phone; each keeps a cached timetable for offline use.
const KEY = "yeg.stops";
const $ = (s) => document.querySelector(s);
let stops = load();
// Android app moved from bus.fysh.site: that domain's storage stays behind, so take the stops back from the widget's copy.
if (!stops.length && window.YegApp && YegApp.stops) {
  try { stops = clean(JSON.parse(YegApp.stops())); } catch (e) { console.warn("widget stops:", e.message); }
}
// Before v76, "Show more routes" saved "Buses to show" as 10 with no way back. Undo that once (a 10 picked in settings goes too).
try {
  if (!localStorage.getItem("yeg.n10")) {
    const hit = stops.filter((s) => s.n === 10);
    hit.forEach((s) => delete s.n);
    if (hit.length) save();
    localStorage.setItem("yeg.n10", "1");
  }
} catch (e) { console.warn("n10:", e.message); }

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
  const t = setTimeout(() => ctl.abort(), 11000); // the edge tries the Pi 4 s, then TrueNAS 6 s
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

// One timer, the bus. With a walk time set, a badge under it says when to leave for it (two timers read as one, 2026-10-23).
function row(d, now, walk = 0, stopId = "") {
  const bg = "var(--accent)"; // one brand green, not ETS route colours, so nobody takes this for the official app
  const fg = "var(--accent-text)";
  const atNow = d.at && d.time - now < 60;
  const early = d.at && !atNow; // here already, waiting to leave: the number is when it pulls out, so say that
  const out = d.time - walk * 60; // when to leave home; buses you can't reach anymore are already off the list
  const leave = walk && !atNow && (out - now < 30 ? `<small class="lbl here go">Leave now</small>`
    : `<small class="lbl here">Leave ${out - now >= 3570 ? `at ${clock(out)}` : `in ${Math.round((out - now) / 60)} min`}</small>`);
  const tag = leave || (early ? `<small class="lbl here">Bus is here</small>` : d.live ? `<small class="live">live</small>` : `<small>scheduled</small>`);
  // Every countdown says what it counts to; "at" when an hour or more out, where mins() shows a clock time.
  const lbl = (word, t) => `<small class="lbl">${word} ${t - now >= 3570 ? "at" : "in"}</small>${mins(t, now)}`;
  const when = atNow ? `<span class="due">At stop</span>` : d.time - now < 30 ? mins(d.time, now) : lbl(early ? "Leaves" : "Bus", d.time);
  const map = d.live && d.trip ? ` data-trip="${esc(d.trip)}" data-stop="${esc(stopId)}" title="Show this bus on a map"` : "";
  return `<div class="dep"${map}><span class="route" style="background:${esc(bg)};color:${esc(fg)};--len:${routeLabel(d.route).length}">${esc(routeLabel(d.route))}</span>
    <span class="head">${esc(headLabel(d.headsign, d.route))}</span><span class="when">${when}${tag}</span></div>`;
}

// Per-stop settings, like the wall board's: only my routes, walk time, how many routes.
// One line per route and direction; tap it to list its buses, tap a live bus for the map.
const expanded = new Set(); // "stop|route|headsign" lines left open across refreshes
const allRoutes = new Set(); // stop ids showing every route for now; "Buses to show" stays as set
// Snow, rain or bitter cold add up to 3 min on top of every walk time you set (from /api/weather).
let wx = { extra: 0, why: "" };
const walkOf = (s) => (s.walk ? s.walk + wx.extra : 0);
async function loadWeather() {
  try { wx = await api("weather"); } catch (e) { console.warn("weather:", e.message); }
}
function grouped(s, list, now) {
  const walk = walkOf(s) * 60, groups = new Map();
  const keep = list.filter((d) => !(s.only && !s.only.includes(d.route)) && !(walk && d.time - walk < now));
  if (s.list === "time") return byTime(s, keep.sort((a, b) => a.time - b.time), now);
  for (const d of keep) {
    const key = `${s.id}|${d.route}|${d.headsign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const html = [...groups].slice(0, allRoutes.has(s.id) ? undefined : s.n || 3).map(([key, ds], i) => {
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
  const more = groups.size - (s.n || 3); // past the card's route count: say so, or a route just looks like it stopped running
  return html && `<div class="deps">${html}</div>` + (more > 0 ? `<button class="more-routes" data-more="${esc(s.id)}" aria-expanded="${allRoutes.has(s.id)}">${allRoutes.has(s.id) ? "Show fewer routes" : `Show ${more} more route${more > 1 ? "s" : ""}`}</button>` : "");
}
// "All by time": one list, soonest first, across the stop's chosen routes; "Buses to show" counts buses here.
function byTime(s, ds, now) {
  const n = allRoutes.has(s.id) ? Math.min(ds.length, 30) : s.n || 3;
  const html = ds.slice(0, n).map((d, i) => {
    const r = row(d, now, walkOf(s), s.id);
    return `<div class="grp">${i ? r : r.replace('class="dep', 'class="dep lead').replace(/<\/div>$/, wave(s, d, now) + "</div>")}</div>`;
  }).join("");
  const more = Math.min(ds.length, 30) - (s.n || 3);
  return html && `<div class="deps">${html}</div>` + (more > 0 ? `<button class="more-routes" data-more="${esc(s.id)}" aria-expanded="${allRoutes.has(s.id)}">${allRoutes.has(s.id) ? "Show fewer buses" : `Show ${more} more bus${more > 1 ? "es" : ""}`}</button>` : "");
}

// Wave under the lead bus: full when it's time to go, filling over the last 15 minutes. Drawn by drawWaves().
// What pulls in when the lead is Due, drawn from the side facing right; w is its width, b how far its wheels reach below 0.
// The ETS Xcelsior has its front door ahead of the front wheel and the rear door between the wheels.
const LRT = (stripe) => `<path d="M32.5-11.5l-4-4h10l-4 4" fill="none" class="pole"/><path class="white" d="M7.5-11.5H57.5Q61.5-11.5 63.5-6L65 5V7H0V5L1.5-6Q3.5-11.5 7.5-11.5Z"/>`
  + `<path class="glass" d="M4.5-8.5H61L62.5 0H2.5Z"/><path d="M14.5-8.5v8.5M50.5-8.5v8.5" class="mullion"/><rect class="door" x="17.5" y="-8.5" width="5" height="15.5"/>`
  + `<rect class="door" x="42.5" y="-8.5" width="5" height="15.5"/><rect class="${stripe}" x="0" y="3" width="65" height="2"/><rect class="sign" x="59" y="-10.4" width="3.6" height="1.3" rx=".3"/>`
  + `<rect class="bogie" x="4.5" y="7" width="13" height="3" rx="1"/><rect class="bogie" x="47.5" y="7" width="13" height="3" rx="1"/><circle class="tyre" cx="7.5" cy="9.5" r="2.4"/>`
  + `<circle class="tyre" cx="14.5" cy="9.5" r="2.4"/><circle class="tyre" cx="50.5" cy="9.5" r="2.4"/><circle class="tyre" cx="57.5" cy="9.5" r="2.4"/>`;
const VEHICLES = {
  bus: { w: 50.5, b: 13, svg: `<path class="blue" d="M3-11H44Q48-11 49-7L50.5 4V7Q50.5 9 48.5 9H2Q0 9 0 7V-8Q0-11 3-11Z"/><path class="white" d="M0 0H50.3L50.5 4V7Q50.5 9 48.5 9H2Q0 9 0 7Z"/>`
    + `<rect class="glass" x="2" y="-8" width="19" height="6.6" rx=".8"/><rect class="glass" x="27" y="-8" width="12" height="6.6" rx=".8"/><path class="glass" d="M45-8H48.2L49.8 2H45Z"/>`
    + `<rect class="door" x="21.5" y="-8" width="5" height="16" rx=".5"/><rect class="door" x="39.5" y="-8" width="5" height="16" rx=".5"/><path d="M24-8v16M42-8v16M8.5-8v6.6M15-8v6.6M33-8v6.6" class="pillar"/>`
    + `<rect class="sign" x="44.6" y="-10.2" width="4.4" height="1.6" rx=".4"/><circle class="lamp" cx="49.7" cy="5.5" r=".9"/>`
    + `<circle class="tyre" cx="10" cy="9" r="4"/><circle class="tyre" cx="34" cy="9" r="4"/><circle class="hub" cx="10" cy="9" r="1.7"/><circle class="hub" cx="34" cy="9" r="1.7"/>` },
  Capital: { w: 65, b: 10.9, svg: LRT("blue") }, // Capital Line cars carry blue, Metro Line red
  Metro: { w: 65, b: 10.9, svg: LRT("red") },
  Valley: { w: 64, b: 9.4, svg: `<path d="M32-11.5l-4-4h10l-4 4" fill="none" class="pole"/><path class="white" d="M5-11.5H58Q63-11.5 64-5V6Q64 8 62 8H2Q0 8 0 6V-5Q1-11.5 5-11.5Z"/>`
    + `<path class="glass" d="M3-8.5H60.5Q62.5-8.5 63-4V1H1.5V-6Z"/><rect class="door" x="11" y="-8.5" width="4.5" height="16"/><rect class="door" x="29.7" y="-8.5" width="4.5" height="16"/>`
    + `<rect class="door" x="48.5" y="-8.5" width="4.5" height="16"/><rect class="green" x="0" y="2.5" width="64" height="1.6"/><rect class="sign" x="57.5" y="-10.6" width="4" height="1.3" rx=".3"/>`
    + `<rect class="tyre" x="3" y="8" width="58" height="2.4" rx="1.2"/>` },
};
function wave(s, d, now) {
  const m = (d.time - walkOf(s) * 60 - now) / 60;
  const f = m < 0.5 ? 1 : Math.min(1, Math.max(0.04, 1 - m / 15)); // "Due" (rounds to 0 min) means full, same as mins()
  const v = VEHICLES[d.route] || VEHICLES.bus;
  return `<svg class="wave" data-stop="${esc(s.id)}" data-f="${f.toFixed(3)}" data-vw="${v.w}" data-vb="${v.b}" viewBox="0 0 330 24" aria-hidden="true"><path class="track"/><path class="fill"/>`
    + `<g class="bus" opacity="0"><g class="bus-body">${v.svg}</g></g></svg>`;
}
// Big waves on the left shrink to flat at the tip, which runs into the track line. On arrival it fills, flattens,
// the route badge bounces once and a bus pulls in to the end of the line. State per stop survives the 30 s re-render so the wave glides, not jumps.
const waves = new Map(), still = matchMedia("(prefers-reduced-motion: reduce)");
function drawWaves() {
  for (const svg of document.querySelectorAll(".stop:not([hidden]) .lead .wave")) {
    if (!svg.getClientRects().length) continue; // hidden by the look or the wall board
    const f = +svg.dataset.f, id = svg.dataset.stop, W = Math.round(svg.clientWidth) || 330;
    if (svg.viewBox.baseVal.width !== W) svg.setAttribute("viewBox", `0 0 ${W} 24`); // real pixels, so the bus keeps its shape
    const w = waves.get(id) || { cur: f, amp: f >= 1 ? 0 : 8, phase: 0, arrived: false, bus: f >= 1 ? 1 : 0 };
    const k = still.matches ? 1 : 0.04;
    w.cur += (f - w.cur) * k;
    w.amp += ((f >= 1 ? 0 : 8) - w.amp) * (still.matches ? 1 : 0.08);
    w.phase += still.matches ? 0 : 0.045;
    w.bus += ((f >= 1 ? 1 : 0) - w.bus) * (still.matches ? 1 : 0.05);
    if (f >= 1 && !w.arrived) { w.arrived = true; svg.closest(".dep").querySelector(".route").classList.add("arrive"); }
    if (f < 1) w.arrived = false;
    waves.set(id, w);
    const end = w.cur * W, pts = [];
    for (let x = 0; x <= end; x += 2.5) pts.push(`${x ? "L" : "M"}${x.toFixed(1)} ${(12 + w.amp * Math.pow(1 - x / end, 0.85) * Math.sin(x * 330 / W / 9 - w.phase)).toFixed(2)}`);
    pts.push(`L${end.toFixed(1)} 12`);
    svg.querySelector(".fill").setAttribute("d", pts.join(""));
    svg.querySelector(".track").setAttribute("d", end < W ? `M${end.toFixed(1)} 12H${W}` : "");
    const bus = svg.querySelector(".bus"), ease = 1 - Math.pow(1 - w.bus, 3);
    bus.setAttribute("opacity", Math.min(1, w.bus * 2).toFixed(2));
    const vw = +svg.dataset.vw, vb = +svg.dataset.vb, sc = vw > 60 ? 1 : 1.1; // wheels rest on top of the line
    bus.setAttribute("transform", `translate(${(W - vw * sc - (1 - ease) * W * 0.4).toFixed(1)} ${(9.5 - vb * sc).toFixed(2)}) scale(${sc})`);
  }
  requestAnimationFrame(drawWaves);
}
requestAnimationFrame(drawWaves);
const editing = new Set();
let firstStop = null, wiz = 0;
function settingsPanel(s) {
  const all = s.allRoutes || [];
  if (s.id === firstStop) return setupStep(s, all);
  const chips = all.map((r) => `<button class="chip" aria-pressed="${!s.only || s.only.includes(r)}" data-route="${esc(r)}">${esc(routeLabel(r))}</button>`).join("");
  const opt = (vals, cur, f) => vals.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${f(v)}</option>`).join("");
  const shown = stops.filter((x) => !group || x.group === group), at = shown.indexOf(s); // the order on the tab you're on
  return `<div class="settings" data-stop="${esc(s.id)}">
    <div class="prefs-bar"><button class="icon-btn" type="button" data-settings="${esc(s.id)}" aria-label="Back" title="Back"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><h2>${esc(s.name)}<span class="sub">Stop #${esc(s.code)}</span></h2></div>
    ${all.length ? `<p class="label">Pick routes</p><div class="chips">${chips}</div>` : ""}
    <label>Walk to this stop <span><input type="number" data-set="walk" min="0" max="60" step="1" inputmode="numeric" value="${Number(s.walk) || 0}"> min</span></label>
    <label>Group <select data-set="group">${opt(["", ...new Set([...GROUPS, ...groupNames()]), "+"], s.group || "",
      (v) => esc(v === "" ? "None" : v === "+" ? "New group..." : v))}</select></label>
    ${shown.length > 1 ? `<div class="row">Order <span class="order"><button type="button" data-move="-1"${at ? "" : " disabled"}>Up</button> ${at + 1} of ${shown.length}
      <button type="button" data-move="1"${at < shown.length - 1 ? "" : " disabled"}>Down</button></span></div>` : ""}
    <label>Buses to show <select data-set="n">${opt([3, 4, 5, 6, 8, 10], s.n || 3, String)}</select></label>
    <label>List <select data-set="list">${opt(["", "time"], s.list || "", (v) => (v ? "All buses by time" : "Grouped by route"))}</select></label>
    ${all.length ? `<label>I change buses: ride <select data-set="ride">${opt(["", ...(s.only || all)], s.xfer?.route || "",
      (v) => (v ? esc(routeLabel(v)) : "No"))}</select></label>${s.xfer ? xferPicker(s) : ""}` : ""}
    <button class="primary" data-settings="${esc(s.id)}">Done</button></div>`;
}

// First stop: one plain question a screen, big buttons (ask 144). Steps: routes, walk, what it's for, done.
function setupStep(s, all) {
  if (wiz === 0 && !all.length) wiz = 1;
  const id = esc(s.id), back = wiz > (all.length ? 0 : 1) ? `data-wiz="-1"` : `data-settings="${id}"`;
  const dots = [0, 1, 2, 3].map((i) => `<span${i === wiz ? ' class="on"' : ""}></span>`).join("");
  const next = `<button class="primary big" type="button" data-wiz="1">Next</button>`;
  const steps = [
    () => `<h2>Which buses do you take?</h2><p class="note">Leave them all ticked if you're not sure.</p>
      <div class="wiz-list">${all.map((r) => `<button class="wiz-row" type="button" aria-pressed="${!s.only || s.only.includes(r)}" data-route="${esc(r)}"><span class="tick"></span>${esc(routeLabel(r))}</button>`).join("")}</div>${next}`,
    () => `<h2>How long is your walk to the stop?</h2>
      <div class="wiz-walk"><button class="icon-btn" type="button" data-walk="-1" aria-label="Less">&minus;</button><b>${Number(s.walk) || 0} min</b><button class="icon-btn" type="button" data-walk="1" aria-label="More">+</button></div>
      <input type="range" data-set="walk" min="0" max="30" step="1" value="${Number(s.walk) || 0}" aria-label="Walk in minutes">
      <p class="note">On snowy or very cold days we add a little extra time for you.</p>${next}
      <button class="big" type="button" data-walk="0">I don't need this</button>`,
    () => `<h2>What's this stop for?</h2><div class="wiz-tiles">${[...GROUPS, "Shopping"].map((g) => `<button type="button" data-wiz-group="${g}">${g}</button>`).join("")}</div>
      <button class="big" type="button" data-wiz-group="+">Something else</button><button class="big" type="button" data-wiz-group="">Skip</button>`,
    () => `<h2>You're all set</h2><p class="note">${esc(s.name)} is saved. Change anything later with the sliders button on its card.</p>
      <button class="primary big" type="button" data-settings="${id}">Show my bus</button><button class="big" type="button" data-wiz-add>Add another stop</button>`,
  ];
  return `<div class="settings wiz" data-stop="${id}">
    <div class="prefs-bar"><button class="icon-btn" type="button" ${back} aria-label="Back" title="Back"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="dots" aria-label="Step ${wiz + 1} of 4">${dots}</div></div>
    ${steps[wiz]()}</div>`;
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
  const walk = s.walk ? ` &middot; ${s.walk} min walk${wx.extra ? ` + ${wx.extra} for ${esc(wx.why)}` : ""}` : "";
  return `<div class="stop-head"><h2>${esc(s.name)}<span class="sub">Stop #${esc(s.code)}${s.where ? ` &middot; ${esc(s.where)}` : ""}${walk}</span></h2>
    <button class="icon-btn" data-settings="${esc(s.id)}" aria-label="Settings for ${esc(s.name)}" title="Settings" aria-expanded="${editing.has(s.id)}">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
    </button>
    <button class="icon-btn" data-remove="${esc(s.id)}" aria-label="Remove ${esc(s.name)}" title="Remove">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button></div>`;
}

// Why a stop shows nothing: say the walk time hid them when it did, not that no bus is coming.
const none = (s, list) => `<p class="note">${s.walk && list.some((d) => !s.only || s.only.includes(d.route))
  ? "No bus you can still walk to in the next 3 hours." : `No ${s.only ? "buses on your routes" : "departures"} in the next 3 hours.`}</p>`;

async function renderStop(s, el) {
  const now = Math.floor(Date.now() / 1000);
  let body, offline = false;
  try {
    const x = s.xfer?.to && api(`stops/${encodeURIComponent(s.id)}/transfer?` + new URLSearchParams(
      { route: s.xfer.route, off: s.xfer.off, at: s.xfer.at, to: s.xfer.to, walk_m: s.xfer.walk_m }))
      .catch((e) => ({ error: e.message })); // said on the card: a missing line would read as no transfer to make
    const d = await api(`stops/${encodeURIComponent(s.id)}/departures?n=30`);
    if (d.stop.routes) s.allRoutes = d.stop.routes.split(",");
    Object.assign(s, { lat: d.stop.lat, lon: d.stop.lon, where: d.stop.where }); // nearest group; which kerb
    save();
    const xf = await x;
    body = alertBox(s, d.alerts || []) + (xf?.error ? `<p class="note">Can't check your change to ${esc(routeLabel(s.xfer.to))} right now.</p>` : xf ? xferLine(s, xf, d.now) : "") +
      (grouped(s, d.departures, d.now) || none(s, d.departures));
    if (d.live_age == null) delete el.dataset.live; // ETS never answered since the server started: nothing here is live
    else el.dataset.live = d.live_age > 120 ? now - d.live_age : now; // ETS's feed itself stalled: the stale pill says so
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
    body = !rows ? `<p class="note">No saved timetable for this stop yet.</p>` : grouped(s, rows, now) ||
      (rows.length ? none(s, rows) : `<p class="note">The saved timetable has run out. It updates next time you're online.</p>`);
    body += `<p class="note">Scheduled times only. Buses may be early or late.</p>`;
  }
  if (offline && smsOk(s)) body += `<a class="sms" href="${smsLink(s)}">Text ${esc(s.code)} to 31100 for live times</a>`;
  const was = el.querySelector(".lead .when")?.textContent;
  el.innerHTML = stopHead(s) + (editing.has(s.id) ? settingsPanel(s) : "") + body;
  el.classList.toggle("editing", editing.has(s.id));
  const now2 = el.querySelector(".lead .when");
  if (was && now2 && now2.textContent !== was) now2.classList.add("tick"); // the new minute rolls in
  return offline;
}

async function renderAll() {
  const main = $("#stops");
  renderTabs();
  $("#empty").hidden = stops.length > 0;
  $("#intro").hidden = stops.length > 0; // the pitch is for newcomers and search engines; once stops are saved, leave the space open
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
    el.classList.toggle("walk", !!s.walk); // walk time set: the card says when to leave
    return renderStop(s, el);
  }));
  const off = results.some(Boolean);
  $("#offline").hidden = !off;
  $("#offline").textContent = !off ? "" : navigator.onLine ? "Live times are down right now. Showing saved scheduled times instead." : "No connection. Showing saved scheduled times instead of live times.";
  const at = [...main.children].filter((c) => !c.hidden && c.dataset.live).map((c) => +c.dataset.live); // ETS's own last update, not ours
  $("#updated").textContent = !stops.length || off ? "" : at.length ? `Live times, updated ${clock(Math.min(...at))}` : "No live times from ETS right now: scheduled times.";
  checkStale();
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
  const at = here ? `&lat=${here.lat.toFixed(2)}&lon=${here.lon.toFixed(2)}` : ""; // about 1 km: enough to rank, not where you stand
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
  nearMap = L.map("near-map", { zoomControl: false, maxZoom: 19 });
  baseMap(nearMap);
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
  if (open) { if (focus) $("#q").focus(); } else { $("#results").innerHTML = ""; $("#q").value = ""; $("#q").placeholder = "Address, place or stop #"; $("#q").inputMode = "search"; }
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
    if (!stops.length) { firstStop = s.id; wiz = 0; setEdit(s.id); } // onboarding: straight into its settings
    if (!stops.some((x) => x.id === s.id)) { stops.push(s); save(); }
    if (add.closest("#map-sheet")) closeMap(); // added from the bus map: show it on the board
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
  const mv = e.target.closest("[data-move]");
  if (mv) { // the top card is the big one: the owner's priority (2026-10-29)
    const s = stops.find((x) => x.id === mv.closest(".settings").dataset.stop);
    const shown = stops.filter((x) => !group || x.group === group), o = shown[shown.indexOf(s) + Number(mv.dataset.move)];
    if (!o) return;
    const i = stops.indexOf(s), j = stops.indexOf(o);
    [stops[i], stops[j]] = [o, s];
    save();
    const main = $("#stops");
    stops.forEach((x) => { const el = main.querySelector(`[data-id="${CSS.escape(x.id)}"]`); if (el) main.append(el); });
    rerender(s.id);
  }
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    const i = stops.findIndex((x) => x.id === rm.dataset.remove), gone = stops[i];
    stops.splice(i, 1); save(); renderAll();
    $("#undo span").textContent = `Removed ${gone.name}`;
    $("#undo").hidden = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { $("#undo").hidden = true; }, 8000);
    $("#undo button").onclick = () => { stops.splice(Math.min(i, stops.length), 0, gone); save(); renderAll(); $("#undo").hidden = true;
      const main = $("#stops"), el = main.querySelector(`[data-id="${CSS.escape(gone.id)}"]`); // renderAll adds it last
      main.insertBefore(el, main.children[i]);
    };
  }
  const step = e.target.closest("[data-wiz],[data-walk],[data-wiz-group],[data-wiz-add]");
  if (step) {
    const s = stops.find((x) => x.id === firstStop), d = step.dataset;
    if (!s) return;
    if (d.walk === "0") { s.walk = 0; wiz++; }
    else if (d.walk) s.walk = Math.min(30, Math.max(0, (Number(s.walk) || 0) + Number(d.walk)));
    else if (d.wizGroup != null) {
      let g = d.wizGroup;
      if (g === "+") { g = (prompt("Name it, like Gym or Mom's") || "").trim().slice(0, 20); if (!g) return; }
      s.group = g || undefined; wiz++; showGroup();
    } else if (d.wiz) wiz = Math.max(0, wiz + Number(d.wiz));
    save();
    if (d.wizAdd != null) { // the search box is hidden until the stop's page closes
      if (history.state?.edit) { addEventListener("popstate", () => setAdd(true), { once: true }); history.back(); } else { setEdit(null); setAdd(true); }
      return;
    }
    rerender(s.id); scrollTo(0, 0);
  }
  const more = e.target.closest("[data-more]");
  if (more) { const id = more.dataset.more; allRoutes.has(id) ? allRoutes.delete(id) : allRoutes.add(id); rerender(id); }
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
  if (k === "list") {
    s.list = e.target.value || undefined;
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

// Bus map: tap a live bus. Leaflet loads on first use; the position is checked every 5 s while open (ETS moves it every 30 s).
let mapState = null;
function loadFile(src, integrity) {
  const css = src.endsWith(".css"), el = document.createElement(css ? "link" : "script");
  if (css) el.rel = "stylesheet";
  el.crossOrigin = "anonymous"; el[css ? "href" : "src"] = src; el.integrity = integrity;
  return new Promise((ok, fail) => { el.onload = ok; el.onerror = () => fail(new Error("map library did not load")); document.head.append(el); });
}
let mapLib = null;
function loadLeaflet() { // Leaflet draws the pins and lines; MapLibre draws OpenFreeMap's plain base map under them
  return mapLib ??= Promise.all([
    loadFile("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css", "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=="),
    loadFile("https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css", "sha512-qN/uDg9bS3IAldWq4lswyC+9ZSoShtfyNDp+FaJhdtXJqdgubHA+s4nB8BajW0m90Y0+RBGbqu2anzbxiQYdHA=="),
    loadFile("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g=="),
    loadFile("https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js", "sha512-dXgoFR02YHJ9Fa29P3D/1umNaZ0EXS2N0w29Lm3b/1BK8UDLMdLWDFwuujIyJJdU27/PLuk3dmS1V9NO8ABX1A=="),
  ]).then(() => loadFile("https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.min.js",
    "sha512-baUs1iJo1j5p13bQBdGKGW+C8z5q0+vAi/8B75SSFjaUgvZV5Tl7LAB9aNHgSX7gzbb9FAggLdbloV9KPYRUmw==")).catch((e) => { mapLib = null; throw e; });
}
// OpenFreeMap's grey Positron (free, no usage limits, unlike OpenStreetMap's own tile servers), with parks and water
// tinted like Google's so the city still reads at a glance.
const TINT = { park: ["fill-color", "#cdebd2"], landcover_wood: ["fill-color", "#d3edd6"], water: ["fill-color", "#aad8ee"], waterway: ["line-color", "#aad8ee"] };
function baseMap(map) {
  const gl = L.maplibreGL({ style: "https://tiles.openfreemap.org/styles/positron",
    attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  gl.once("add", () => gl.getMaplibreMap().on("load", (e) => { // its MapLibre map exists only once Leaflet has a view
    for (const [id, [k, v]] of Object.entries(TINT)) if (e.target.getLayer(id)) e.target.setPaintProperty(id, k, v);
  }));
  gl.addTo(map);
}
async function openMap(dep) {
  const s = stops.find((x) => x.id === dep.dataset.stop);
  const g = dep.closest(".grp")?.querySelector(".grp-head") || dep; // rows inside a group carry no route or headsign
  const label = g.querySelector(".route"), head = g.querySelector(".head").firstChild.textContent;
  $("#map-title").innerHTML = `Route ${esc(label.textContent)} to ${esc(head)}<span class="sub">${esc(s ? s.name : "")}</span>`;
  $("#map-note").textContent = "Finding the bus...";
  $("#map-sheet").showModal();
  if (!await sheetMap()) return;
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
  // A pin the bus's size in a 52 px tap area: the old 16 px dot was hard to hit with a thumb.
  if (s && s.lat) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "you-pin", iconSize: [52, 52],
    html: `<span><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h12v10h-5v10h-2V12H6z"/></svg></span>` }) })
    .bindTooltip("Your stop").addTo(m.layer);
  await placeBus();
  clearInterval(m.timer);
  m.timer = setInterval(placeBus, 5000);
}
async function sheetMap() {
  try { await loadLeaflet(); } catch (e) { $("#map-note").textContent = `Map unavailable: ${e.message}`; return false; }
  if (!mapState) {
    const map = L.map("map-box", { zoomControl: false, maxZoom: 19 });
    baseMap(map);
    mapState = { map, layer: L.layerGroup().addTo(map), timer: 0 };
    map.on("moveend", () => { if (mapState.trip === "all") { drawFleet(); drawStops(); } });
  }
  clearInterval(mapState.timer);
  return true;
}
// Every bus in the city, live. The server keeps one copy of ETS's positions for everyone, so watching costs ETS nothing.
async function openLiveMap() {
  $("#map-title").innerHTML = `Every bus, live<span class="sub">Tap a bus to see where it's going</span>`;
  $("#map-note").textContent = "Finding buses...";
  $("#map-sheet").showModal();
  if (!await sheetMap()) return;
  const m = mapState, home = stops.find((s) => s.lat);
  m.trip = "all"; m.buses = []; m.layer.clearLayers(); m.fleet = L.layerGroup().addTo(m.layer);
  m.stopPins = L.layerGroup().addTo(m.layer); m.stopsAt = null;
  m.map.invalidateSize();
  m.map.setView(home ? [home.lat, home.lon] : [53.5461, -113.4938], 14); // your first stop, or downtown
  await placeFleet();
  m.timer = setInterval(placeFleet, 5000);
}
async function placeFleet() {
  if (document.hidden) return; // a map left open in a background tab doesn't keep asking
  try {
    const d = await api("vehicles");
    if (mapState.trip !== "all") return;
    mapState.buses = d.buses; mapState.vpAt = d.age > 90 ? d.now - d.age : 0;
    drawFleet();
  } catch (e) {
    if (mapState.trip !== "all") return;
    $("#map-title").firstChild.textContent = "Every bus, not live";
    $("#map-note").textContent = `Can't get bus positions (${e.message}).`;
  }
}
function drawFleet() { // only the buses in view: a city of pins at once makes a phone crawl
  const m = mapState, view = m.map.getBounds().pad(0.2), far = m.map.getZoom() < 13;
  const seen = m.buses.filter(([lat, lon]) => view.contains([lat, lon]));
  m.fleet.clearLayers();
  for (const [lat, lon, , route, head] of seen) L.marker([lat, lon], { icon: L.divIcon({ className: "", iconSize: far ? [18, 18] : [40, 40],
    html: `<span class="bus-pin fleet${far ? " far" : ""}">${far ? "" : esc(routeLabel(route))}</span>` }) })
    .bindTooltip(`Route ${esc(routeLabel(route))} to ${esc(headLabel(head, route))}`).addTo(m.fleet);
  $("#map-title").firstChild.textContent = m.vpAt ? "Every bus, not live" : "Every bus, live";
  $("#map-note").textContent = m.vpAt // ETS's position feed stalled: these are where buses were, not are
    ? `Bus positions from ${clock(m.vpAt)}: ETS isn't sending new ones.` : `${m.buses.length} buses running, ${seen.length} here. ETS updates every 30 s.`;
}
// Stops under the buses once zoomed in close enough to tell them apart. Asked for again only after the map moves
// 300 m: every ask is a Pages Function call (100k a day free). Dots, not pins, so the buses stay on top.
const STOP_ZOOM = 16, stopDots = () => L.canvas({ tolerance: 12 }); // 12 px of slack: a thumb on a 7 px dot
async function drawStops() {
  const m = mapState, c = m.map.getCenter();
  if (m.map.getZoom() < STOP_ZOOM) { m.stopPins.clearLayers(); m.stopsAt = null; return; }
  if (m.stopsAt && metres(m.stopsAt, { lat: c.lat, lon: c.lng }) < 300) return;
  const at = m.stopsAt = { lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4) };
  let list;
  try { list = await api(`stops/near?lat=${at.lat}&lon=${at.lon}&n=60`); }
  catch (e) { m.stopsAt = null; console.warn("map stops:", e.message); return; }
  if (m.stopsAt !== at || m.trip !== "all") return; // moved again, or another map opened, while this was asked
  m.renderer = m.renderer || stopDots();
  m.stopPins.clearLayers();
  for (const s of list) L.circleMarker([s.lat, s.lon], { renderer: m.renderer, radius: 7, weight: 2, color: "#fff", fillColor: "#17694a", fillOpacity: 1 })
    .bindPopup(() => stopCard(s), { closeButton: false, minWidth: 210 }).addTo(m.stopPins);
}
// A tapped stop: its name, its next buses, and Add.
function stopCard(s) {
  const el = document.createElement("div"), saved = stops.some((x) => x.id === s.id);
  const routes = s.routes ? ` &middot; ${s.routes.includes(",") ? "Routes" : "Route"} ${esc(s.routes.split(",").map(routeLabel).join(", "))}` : "";
  const add = { id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon };
  el.className = "pin-card";
  el.innerHTML = `<b>${esc(s.name)}</b><span class="sub">Stop #${esc(s.code)}${routes}</span><span class="next sub">Next buses...</span>
    <button ${saved ? "disabled" : ""} data-add='${esc(JSON.stringify(add))}'>${saved ? "Saved" : "Add this stop"}</button>`;
  api(`stops/${encodeURIComponent(s.id)}/departures?n=3`).then((d) => {
    const next = d.departures.map((x) => `${esc(routeLabel(x.route))} ${esc(headLabel(x.headsign, x.route))}: ${mins(x.time, d.now).replace(/<[^>]+>/g, "")}`);
    el.querySelector(".next").innerHTML = next.length ? next.join("<br>") : "No buses in the next 3 hours.";
  }).catch((e) => { el.querySelector(".next").textContent = `Can't get times (${e.message}).`; });
  return el;
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
  if (document.hidden) return;
  try {
    const v = await api(`trips/${encodeURIComponent(trip)}${s ? `?stop=${encodeURIComponent(s.id)}` : ""}`);
    if (m.trip !== trip) return; // another bus was opened meanwhile
    m.at = v;
    drawLine();
    if (m.bus) glide(m.bus, [v.lat, v.lon]);
    else m.bus = L.marker([v.lat, v.lon], { zIndexOffset: 1000, icon: L.divIcon({ className: "", iconSize: [46, 46],
      html: `<span class="bus-pin" style="${esc(m.style)}">${esc(m.label)}</span>` }) }).addTo(m.layer);
    m.others.clearLayers();
    for (const o of v.others) L.marker(o, { interactive: false, icon: L.divIcon({ className: "", iconSize: [30, 30],
      html: `<span class="bus-pin other" style="${esc(m.style)}">${esc(m.label)}</span>` }) }).addTo(m.others);
    if (!m.fitted) { // open zoomed in on the bus; one still on another run is off your route, so show it with your stop
      if ((v.before || v.waiting) && s && s.lat) m.map.fitBounds([[v.lat, v.lon], [s.lat, s.lon]], { padding: [50, 50], maxZoom: 16 });
      else m.map.setView([v.lat, v.lon], 16);
      m.fitted = true;
    }
    const km = s && s.lat ? ` It's ${(metres(v, s) / 1000).toFixed(1)} km from your stop.` : "";
    const away = v.before ? `Finishing its run before yours, then it comes to you.${km} ` : v.waiting ? "Hasn't started its trip yet. " : v.stops_away === undefined ? "" : v.stops_away === null ? "Already past your stop. "
      : v.stops_away === 0 ? "Your stop is next. " : `${v.stops_away} stop${v.stops_away > 1 ? "s" : ""} away. `;
    $("#map-note").textContent = `${away}Position ${v.age < 90 ? `${v.age} s` : `${Math.round(v.age / 60)} min`} old, ETS updates every 30 s.`;
  } catch (e) {
    if (m.trip !== trip) return;
    $("#map-note").textContent = e.message.startsWith("404") ? "This bus hasn't sent its position yet. It may not have started its trip." : `Can't get the bus position (${e.message}).`;
  }
}
function closeMap() { if (mapState) clearInterval(mapState.timer); $("#map-sheet").close(); }
$("#map-close").onclick = closeMap;
$("#live-map").onclick = openLiveMap;
$("#map-sheet").addEventListener("close", () => mapState && clearInterval(mapState.timer));
$("#map-sheet").addEventListener("click", (e) => { if (e.target.id === "map-sheet") closeMap(); }); // tap the backdrop

// Onboarding: the empty screen offers the two ways in; tips show once, after the first stop's settings.
$("#ob-near").onclick = () => { setAdd(true, false); $("#near").click(); };
for (const [b, hint, mode] of [["#ob-addr", "Type an address or place", "search"], ["#ob-code", "Stop number, on the sign", "numeric"]])
  $(b).onclick = () => { $("#q").placeholder = hint; $("#q").inputMode = mode; setAdd(true); };
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
// Side by side on a wide screen, every stop gets the big lead look, not just the first (style.css, "The lead bus").
const wide = matchMedia("(min-width: 1000px)");
const setWide = () => document.body.classList.toggle("wide", wide.matches);
wide.addEventListener("change", setWide); setWide();
let wakeLock = null;
// Wall board setting: "auto" (sideways), "on", "off". Exit turns it off until the phone is upright again.
let boardMode = "auto", boardExited = false;
try { boardMode = localStorage.getItem("yeg.board") || "auto"; } catch { /* storage blocked: default */ }
const isBoard = () => !boardExited && (location.hash === "#board" || boardMode === "on" || (boardMode === "auto" && sideways.matches));
async function wake() {
  if (!isBoard() || !navigator.wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { console.warn("wake lock:", e.message); }
}
// Night: the board goes dark and faint from the hour picked until 6 am. A page can't set the backlight.
let nightFrom = "22";
try { nightFrom = localStorage.getItem("yeg.night") || "22"; } catch { /* storage blocked: default */ }
$("#board-night").value = nightFrom;
$("#board-night").onchange = (e) => {
  nightFrom = e.target.value;
  try { localStorage.setItem("yeg.night", nightFrom); } catch (err) { console.warn("night:", err.message); }
  tick();
};
function tick() {
  const now = new Date(), h = now.getHours();
  $("#clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  document.body.classList.toggle("night", nightFrom !== "off" && (h >= +nightFrom || h < 6));
  checkStale();
}
// A tab left open can fall behind (a sleeping laptop, a frozen tab, a stop's settings left open, a new release):
// say so where it shows, the wall board included, instead of passing old times off as live.
let newVersion = false, firstSha = null, undoTimer;
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
// The board scales each card's contents to fill its box: no row cut in half on a small screen, no empty half of a TV.
function fitBoard() {
  const on = document.body.classList.contains("board");
  for (const card of document.querySelectorAll("#stops > .stop")) {
    const kids = [...card.children];
    kids.forEach((k) => { k.style.zoom = ""; });
    if (!on || card.hidden) continue;
    const cs = getComputedStyle(card), avail = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    let z = 1;
    for (let i = 0; i < 3; i++) { // zoom changes line wrapping, so let it settle
      const shown = kids.filter((k) => k.getClientRects().length);
      if (!shown.length) break;
      const used = shown.at(-1).getBoundingClientRect().bottom - shown[0].getBoundingClientRect().top;
      // ponytail: below half size text is unreadable, so 4+ stops on a sideways phone still lose their last row; a 2nd page would fix it.
      z = Math.min(3, Math.max(0.5, z * avail / used));
      kids.forEach((k) => { k.style.zoom = z; });
    }
  }
}
let fitQueued = false;
const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitBoard(); }); } };
new MutationObserver(queueFit).observe($("#stops"), { childList: true, subtree: true });
addEventListener("resize", queueFit);
function applyBoard() {
  const on = isBoard();
  document.body.classList.toggle("board", on);
  if (on) { setAdd(false); setPrefs(false); setEdit(null); wake(); } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  queueFit();
  if (!on && document.fullscreenElement) document.exitFullscreen().catch((e) => console.warn("fullscreen:", e.message));
}
// Browsers only go full screen on a tap, so the board's first tap hides the browser's bars.
document.addEventListener("pointerdown", (e) => {
  if (isBoard() && !document.fullscreenElement && !e.target.closest("#board-exit"))
    document.documentElement.requestFullscreen?.().catch((err) => console.warn("fullscreen:", err.message));
});
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
// Interest-based ads only after a yes in Settings (Alberta PIPA, PIPEDA): until then Google is asked for
// non-personalized ads. Changing it reloads, because AdSense reads the flag once when it starts.
if (!window.YegApp && !isBoard()) {
  let adsMode = "off";
  try { adsMode = localStorage.getItem("yeg.ads") === "on" ? "on" : "off"; } catch (err) { console.warn("ads:", err.message); }
  (window.adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = adsMode === "on" ? 0 : 1;
  $("#ads-row").hidden = false; $("#ads-mode").value = adsMode;
  $("#ads-mode").onchange = (e) => {
    try { localStorage.setItem("yeg.ads", e.target.value); } catch (err) { console.warn("ads:", err.message); }
    location.reload();
  };
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
// The version this page runs, from its own script tag (bumped with every release), so you can tell an update arrived.
$("#version").textContent = `Version ${(document.querySelector('script[src*="app.js"]')?.src.match(/v=(\d+)/) || [, "?"])[1]}`;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=101").catch((e) => console.warn("sw:", e.message));

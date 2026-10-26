// Cloudflare Pages: the site itself is static (web/), so /api/* is passed to the bus server through a tunnel.
// The Pi (Hermes) is the main copy and TrueNAS the fallback. If both are down the page still loads and
// falls back to its saved timetables; this only has to fail fast.
const ORIGINS = [["https://bus-pi.fysh.site", 4000], ["https://bus.fysh.site", 6000]];
// Answers with nothing about the rider in them are shared at this edge: every rider at a stop costs the Pi one call
// per FRESH seconds (the server polls ETS every 10 s). If both copies fail, the last good one (up to KEEP s old)
// is served, aged so its countdowns and the stale pill stay true. Search, transfer and the rest always go through.
const FRESH = [[/^\/api\/stops\/[^/]+\/departures$/, 10], [/^\/api\/vehicles$/, 5], [/^\/api\/stops\/[^/]+\/timetable$/, 600]];
const KEEP = 600;

export async function onRequest({ request, waitUntil }) {
  const url = new URL(request.url);
  const fresh = request.method === "GET" && FRESH.find(([re]) => re.test(url.pathname))?.[1];
  const hit = fresh ? await caches.default.match(request) : null;
  const age = hit ? Date.now() / 1000 - Number(hit.headers.get("x-stored")) : 0;
  if (hit && age < fresh) return aged(hit, age);
  const r = await origin(request, url);
  if (fresh && r.ok) {
    const copy = new Response(r.clone().body, r);
    copy.headers.set("cache-control", `max-age=${KEEP}`);
    copy.headers.set("x-stored", String(Date.now() / 1000));
    waitUntil(caches.default.put(request, copy).catch((e) => console.log("edge cache put", e.message)));
  }
  if (r.status >= 500 && hit) return aged(hit, age);
  return r;
}

async function origin(request, url) {
  for (const [origin, ms] of ORIGINS) {
    try {
      const r = await fetch(origin + url.pathname + url.search, {
        method: request.method,
        headers: { "user-agent": request.headers.get("user-agent") || "" },
        signal: AbortSignal.timeout(ms),
      });
      // 5xx (52x is Cloudflare saying the tunnel or server is unreachable): try the next copy.
      if (r.status < 500) return r;
      console.log("api origin", origin, r.status);
    } catch (e) {
      console.log("api origin", origin, e.message);
    }
  }
  return Response.json({ error: "live times are down" }, { status: 503, headers: { "cache-control": "no-store" } });
}

// A cached answer, moved on by its age: the page counts down from "now" and shows stale data by "live_age"/"age".
async function aged(hit, age) {
  const j = await hit.json(), s = Math.round(age);
  if (typeof j.now === "number") j.now += s;
  if (typeof j.live_age === "number") j.live_age += s;
  if (typeof j.age === "number") j.age += s;
  return Response.json(j, { headers: { "cache-control": "no-store", "x-edge-age": String(s) } });
}

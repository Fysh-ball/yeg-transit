// Cloudflare Pages: the site itself is static (web/), so /api/* is passed to the bus server through a tunnel.
// The Pi (Hermes) is the main copy and TrueNAS the fallback. If both are down the page still loads and
// falls back to its saved timetables; this only has to fail fast.
const ORIGINS = [["https://bus-pi.fysh.site", 4000], ["https://bus.fysh.site", 6000]];
// Answers with nothing about the rider in them are shared at this edge: every rider at a stop costs the Pi one call
// per FRESH seconds (the server polls ETS every 10 s). If both copies fail, the last good one (up to KEEP s old)
// is served, aged so its countdowns and the stale pill stay true. Search, transfer and the rest always go through.
// The shared URL keeps only the one parameter the server reads there, clamped as the server clamps it: a cache-buster
// or n=29 can't make every request a miss that reaches the Pi.
const FRESH = [[/^\/api\/stops\/[^/]+\/departures$/, 10, "n", 8, 30], [/^\/api\/vehicles$/, 5],
  [/^\/api\/stops\/[^/]+\/timetable$/, 600, "hours", 30, 48]];
const KEEP = 600;
const FLYING = new Map(); // shared URL -> its origin call in progress, so a crowd at one stop makes one call (per isolate)

export async function onRequest({ request, waitUntil }) {
  let url = new URL(request.url);
  const rule = request.method === "GET" && FRESH.find(([re]) => re.test(url.pathname));
  const fresh = rule?.[1];
  if (rule) {
    const [, , name, def, max] = rule, key = new URL(url.origin + url.pathname);
    if (name) key.searchParams.set(name, String(Math.min(parseInt(url.searchParams.get(name), 10) || def, max)));
    // the one other parameter that changes the answer: without it Calgary would be served Edmonton's buses
    if (url.pathname === "/api/vehicles" && url.searchParams.get("city") === "cgy") key.searchParams.set("city", "cgy");
    url = key;
  }
  const hit = fresh ? await caches.default.match(url.href) : null;
  const age = hit ? Date.now() / 1000 - Number(hit.headers.get("x-stored")) : 0;
  if (hit && age < fresh) return aged(hit, age);
  let r;
  if (fresh) {
    let p = FLYING.get(url.href);
    if (!p) {
      // text, not the Response: a Worker can't read one request's stream from another request
      // text() undoes any compression, so its encoding and length headers no longer describe the body
      p = origin(request, url).then(async (o) => ({ status: o.status, body: await o.text(),
        headers: [...o.headers].filter(([k]) => k !== "content-encoding" && k !== "content-length") }))
        .catch((e) => ({ status: 503, body: JSON.stringify({ error: "live times are down" }),
          headers: [["content-type", "application/json"], ["cache-control", "no-store"], ["x-edge-error", String(e.message).replace(/[\r\n]/g, " ").slice(0, 100)]] }))
        .then(async (o) => {
          if (o.status >= 200 && o.status < 300) {
            const copy = new Response(o.body, { status: o.status, headers: o.headers });
            copy.headers.set("cache-control", `max-age=${KEEP}`);
            copy.headers.set("x-stored", String(Date.now() / 1000));
            await caches.default.put(url.href, copy).catch((e) => console.log("edge cache put", e.message));
          }
          return o;
        }).finally(() => FLYING.delete(url.href));
      FLYING.set(url.href, p);
      waitUntil(p);
    }
    const o = await p;
    r = new Response(o.body, { status: o.status, headers: o.headers }); // each waiter its own copy of the one answer
  } else r = await origin(request, url);
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
      // 5xx (52x is Cloudflare saying the tunnel or server is unreachable): try the next copy. Not when the server
      // marks it X-No-Failover (an outside host failed or is held back): the other copy would only ask it again.
      if (r.status < 500 || r.headers.get("x-no-failover")) return r;
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

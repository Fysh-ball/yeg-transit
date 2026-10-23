// Cloudflare Pages: the site itself is static (web/), so /api/* is passed to the bus server through a tunnel.
// The Pi (Hermes) is the main copy and TrueNAS the fallback. If both are down the page still loads and
// falls back to its saved timetables; this only has to fail fast.
const ORIGINS = [["https://bus-pi.fysh.site", 4000], ["https://bus.fysh.site", 6000]];

export async function onRequest({ request }) {
  const url = new URL(request.url);
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

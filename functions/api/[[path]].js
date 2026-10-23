// Cloudflare Pages: the site itself is static (web/), so /api/* is passed to the bus server through the tunnel.
// If the server is down the page still loads and falls back to its saved timetables; this only has to fail fast.
// ponytail: one origin; when Hermes runs a second copy, try it here after the first fails.
const ORIGIN = "https://bus.fysh.site";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  try {
    const r = await fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers: { "user-agent": request.headers.get("user-agent") || "" },
      signal: AbortSignal.timeout(8000),
    });
    // 52x is Cloudflare saying the tunnel or server is unreachable: report it the way the app expects.
    if (r.status < 520) return r;
    console.log("api origin", r.status);
  } catch (e) {
    console.log("api origin:", e.message);
  }
  return Response.json({ error: "live times are down" }, { status: 503, headers: { "cache-control": "no-store" } });
}

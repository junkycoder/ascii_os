// acii_os — edge worker.
//
// Serves the zero-build vanilla ES-module shell via the static ASSETS binding,
// plus a thin same-origin proxy for the New Fish time-tracker API.
//
// Why the proxy: new-fish.net's API sends no CORS headers and 404s on the
// preflight, so the browser can't call it cross-origin. The time-track app
// hits `/api/newfish/*` (same origin → no CORS) and we forward to
// `https://new-fish.net/api/v0/*`, relaying the user's X-Auth-* headers. We
// do NOT store or inspect the token — it passes straight through.
const NEWFISH_PREFIX = '/api/newfish/';
const NEWFISH_UPSTREAM = 'https://new-fish.net/api/v0/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(NEWFISH_PREFIX)) {
      return proxyNewfish(request, url);
    }

    return env.ASSETS.fetch(request);
  },
};

async function proxyNewfish(request, url) {
  // Map /api/newfish/<rest> → https://new-fish.net/api/v0/<rest> (+ query string).
  const rest = url.pathname.slice(NEWFISH_PREFIX.length);
  const target = NEWFISH_UPSTREAM + rest + url.search;

  // Forward only the headers New Fish needs; drop hop-by-hop / origin headers.
  const headers = new Headers();
  for (const h of ['x-auth-email', 'x-auth-token', 'content-type', 'accept']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  const init = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  // Relay status + body; force a JSON-friendly content type and same-origin
  // (no CORS headers needed — caller is same origin in prod).
  const body = await upstream.arrayBuffer();
  const respHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) respHeaders.set('content-type', ct);
  respHeaders.set('cache-control', 'no-store');
  return new Response(body, { status: upstream.status, headers: respHeaders });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

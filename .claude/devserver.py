#!/usr/bin/env python3
"""Tiny dev server: http.server + Cache-Control: no-store so module edits
are visible on plain reload without browser cache busting.

Also mirrors the production worker's New Fish proxy: requests to
`/api/newfish/*` are forwarded to `https://new-fish.net/api/v0/*` (relaying the
X-Auth-* headers) so the time-track app works locally despite New Fish having
no CORS. The token only passes through — it is never logged or stored."""
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

NEWFISH_PREFIX = "/api/newfish/"
NEWFISH_UPSTREAM = "https://new-fish.net/api/v0/"
_FORWARD_HEADERS = ("X-Auth-Email", "X-Auth-Token", "Content-Type", "Accept")


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Route any method on the proxy prefix to the upstream; otherwise fall back
    # to the static file handlers.
    def _maybe_proxy(self):
        if self.path.startswith(NEWFISH_PREFIX):
            self._proxy_newfish()
            return True
        return False

    def do_GET(self):
        if not self._maybe_proxy():
            super().do_GET()

    def do_POST(self):
        if not self._maybe_proxy():
            self.send_error(405)

    def do_DELETE(self):
        if not self._maybe_proxy():
            self.send_error(405)

    def do_PUT(self):
        if not self._maybe_proxy():
            self.send_error(405)

    def _proxy_newfish(self):
        rest = self.path[len(NEWFISH_PREFIX):]  # keeps the query string
        target = NEWFISH_UPSTREAM + rest

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method=self.command)
        for h in _FORWARD_HEADERS:
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        if not req.has_header("Content-type"):
            req.add_header("Content-Type", "application/json; charset=utf-8")

        try:
            with urllib.request.urlopen(req, timeout=30) as up:
                status = up.status
                data = up.read()
                ctype = up.headers.get("Content-Type", "application/json; charset=utf-8")
        except urllib.error.HTTPError as e:
            status = e.code
            data = e.read()
            ctype = e.headers.get("Content-Type", "application/json; charset=utf-8")
        except Exception as e:  # noqa: BLE001 — surface upstream/network errors as 502
            status = 502
            data = ('{"error":"upstream fetch failed","detail":%r}' % str(e)).encode()
            ctype = "application/json; charset=utf-8"

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    bind = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    with ThreadingHTTPServer((bind, port), NoCacheHandler) as srv:
        print(f"acii_os dev server: http://{bind}:{port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()

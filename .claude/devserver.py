#!/usr/bin/env python3
"""Tiny dev server: http.server + Cache-Control: no-store so module edits
are visible on plain reload without browser cache busting.

Also mirrors the production worker's New Fish proxy: requests to
`/api/newfish/*` are forwarded to `https://new-fish.net/api/v0/*` (relaying the
X-Auth-* headers) so the time-track app works locally despite New Fish having
no CORS. The token only passes through — it is never logged or stored."""
import base64
import io
import json
import re
import sys
import tarfile
import urllib.parse
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

NEWFISH_PREFIX = "/api/newfish/"
NEWFISH_UPSTREAM = "https://new-fish.net/api/v0/"
_FORWARD_HEADERS = ("X-Auth-Email", "X-Auth-Token", "Content-Type", "Accept")

GIT_CLONE_PREFIX = "/api/git/clone"
GIT_CLONE_MAX_FILES = 4000
GIT_CLONE_MAX_TOTAL = 16 * 1024 * 1024
GIT_CLONE_MAX_FILE = 1024 * 1024


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
        if self.path.split("?")[0] == GIT_CLONE_PREFIX:
            self._git_clone()
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

    def _send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # Mirror the worker's /api/git/clone: fetch a public GitHub repo tarball,
    # unpack it (stdlib gzip+tar via tarfile), and return files as base64.
    def _git_clone(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        spec = (q.get("repo") or [""])[0].strip()
        ref = (q.get("ref") or [""])[0].strip()
        m = re.search(r"github\.com[/:]([^/\s]+)/([^/\s]+?)(?:\.git)?(?:[/#?].*)?$", spec, re.I) \
            or re.match(r"^([^/\s]+)/([^/\s]+?)(?:\.git)?$", spec)
        if not m:
            self._send_json({"error": "bad repo; use owner/name or a github.com URL"}, 400)
            return
        owner, repo = m.group(1), m.group(2)
        target = "https://api.github.com/repos/%s/%s/tarball/%s" % (
            owner, repo, urllib.parse.quote(ref))
        req = urllib.request.Request(target, headers={
            "User-Agent": "FakanOS", "Accept": "application/vnd.github+json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as up:
                raw = up.read()
        except urllib.error.HTTPError as e:
            detail = "repo or ref not found (private repos unsupported)" if e.code == 404 \
                else "github rate limit — try later" if e.code == 403 else ""
            self._send_json({"error": "github %d" % e.code, "detail": detail},
                            404 if e.code == 404 else 502)
            return
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": "github fetch failed", "detail": str(e)}, 502)
            return

        files, total, skipped = [], 0, 0
        try:
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
                for member in tar:
                    if not member.isfile():
                        continue
                    rel = member.name.split("/", 1)[1] if "/" in member.name else ""
                    if not rel:
                        continue
                    if member.size > GIT_CLONE_MAX_FILE:
                        skipped += 1
                        continue
                    if len(files) >= GIT_CLONE_MAX_FILES or total + member.size > GIT_CLONE_MAX_TOTAL:
                        skipped += 1
                        continue
                    f = tar.extractfile(member)
                    data = f.read() if f else b""
                    total += len(data)
                    files.append({"path": rel, "b64": base64.b64encode(data).decode()})
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": "tar parse failed", "detail": str(e)}, 502)
            return

        self._send_json({"repo": "%s/%s" % (owner, repo),
                         "ref": ref or "default", "files": files, "skipped": skipped})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    bind = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    with ThreadingHTTPServer((bind, port), NoCacheHandler) as srv:
        print(f"FakanOS dev server: http://{bind}:{port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()

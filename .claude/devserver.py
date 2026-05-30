#!/usr/bin/env python3
"""Tiny dev server: http.server + Cache-Control: no-store so module edits
are visible on plain reload without browser cache busting."""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    bind = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    with ThreadingHTTPServer((bind, port), NoCacheHandler) as srv:
        print(f"acii_os dev server: http://{bind}:{port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()

"""Dev server: static files, with /thai served by the same index.html (Thai-only mode)."""
import http.server
import sys

ROUTES = {"/thai", "/thai/"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] in ROUTES:
            self.path = "/index.html"
        super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()

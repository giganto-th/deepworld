"""Dev server: static files, with /thai served by the same index.html (Thai-only mode).

/thai gets <base href="/"> so the page's relative paths resolve from the site root,
the same way the GitHub Pages build gives thai/index.html <base href="../">.
"""
import http.server
import sys

ROUTES = {"/thai", "/thai/"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] not in ROUTES:
            return super().do_GET()
        with open("index.html", "rb") as f:
            body = f.read().replace(b"<head>", b'<head>\n  <base href="/">', 1)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()

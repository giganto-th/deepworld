"""Dev server: static files, with the page routes rendered like the production build.

/, /thai/, /en/ and /en/thai/ are index.html with that page's <base> and SEO block
(tools/build.py render), so local URLs behave the same as on GitHub Pages.
"""
import http.server
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'tools'))
from build import PAGES, render  # noqa: E402

ROUTES = {('/' + p).rstrip('/') or '/': p for p in PAGES}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        key = path.rstrip('/') or '/'
        if key not in ROUTES and path != '/index.html':
            return super().do_GET()
        if key != '/' and not path.endswith('/'):  # /thai → /thai/ so relative paths resolve
            self.send_response(301)
            self.send_header('Location', path + '/' + (self.path[len(path):]))
            self.end_headers()
            return
        body = render(ROUTES.get(key, '')).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()

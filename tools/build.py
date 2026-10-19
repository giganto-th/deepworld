"""Static site build: one index.html rendered into a page per mode and language.

    /            world, Thai          /en/          world, English
    /thai/       Thailand, Thai       /en/thai/     Thailand, English

Each page gets its own <base>, <html lang>, and SEO block (title, description, canonical,
hreflang, Open Graph, Twitter, JSON-LD). serve.py uses render() for the dev server;
`python3 tools/build.py _site` writes the deployable site (plus sitemap.xml and robots.txt).
"""
import html
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = 'https://giganto-th.github.io/deepworld/'

PAGES = {  # path → (mode, lang)
    '': ('world', 'th'),
    'thai/': ('thai', 'th'),
    'en/': ('world', 'en'),
    'en/thai/': ('thai', 'en'),
}

TEXT = {
    ('world', 'th'): (
        'DeepWorld — แผนที่โลก 3 มิติ ความสูงของเปลือกโลกบนบกและใต้ทะเล',
        'สำรวจลูกโลก 3 มิติที่แสดงความสูงของภูเขาและความลึกของก้นมหาสมุทร พร้อม 10 อันดับยอดเขาสูงที่สุดและจุดลึกที่สุดของโลก '
        'รอยต่อแผ่นเปลือกโลก และแผนที่ภูมิประเทศประเทศไทยรายจังหวัด อำเภอ ตำบล',
    ),
    ('thai', 'th'): (
        'DeepWorld — แผนที่ภูมิประเทศประเทศไทย 3 มิติ รายจังหวัด อำเภอ ตำบล',
        'แผนที่ภูมิประเทศประเทศไทย 3 มิติแบบละเอียด ดูจุดสูงสุดและต่ำสุดของทั้ง 77 จังหวัด เช่น ดอยอินทนนท์ 2,565 ม. '
        'ค้นหาอำเภอ ตำบล และดูความสูงทุกจุดจากข้อมูล SRTM',
    ),
    ('world', 'en'): (
        'DeepWorld — 3D world elevation map of land and ocean floor',
        'Explore an interactive 3D globe of mountain heights and ocean depths, with the world\'s 10 highest peaks and '
        '10 deepest points, tectonic plate boundaries, and a detailed terrain map of Thailand.',
    ),
    ('thai', 'en'): (
        'DeepWorld — 3D terrain map of Thailand by province, district and subdistrict',
        'Detailed 3D terrain of Thailand: the highest and lowest points of all 77 provinces (e.g. Doi Inthanon, 2,565 m), '
        'search any district or subdistrict, and read the elevation anywhere from SRTM data.',
    ),
}
OG_LOCALE = {'th': 'th_TH', 'en': 'en_US'}


def page_path(mode, lang):
    return ('en/' if lang == 'en' else '') + ('thai/' if mode == 'thai' else '')


def seo_block(path):
    mode, lang = PAGES[path]
    title, desc = TEXT[(mode, lang)]
    url = SITE_URL + path
    other = 'en' if lang == 'th' else 'th'
    alt_url = SITE_URL + page_path(mode, other)
    e = lambda s: html.escape(s, quote=True)
    ld = {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        'name': 'DeepWorld',
        'url': url,
        'description': desc,
        'inLanguage': lang,
        'applicationCategory': 'EducationalApplication',
        'operatingSystem': 'Any (WebGL browser)',
        'image': SITE_URL + 'assets/og-image.jpg',
        'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'THB'},
        'about': ['Topography', 'Bathymetry', 'Thailand', 'Mount Everest', 'Mariana Trench'],
    }
    lines = [
        f'<title>{e(title)}</title>',
        f'<meta name="description" content="{e(desc)}" />',
        f'<link rel="canonical" href="{url}" />',
        f'<link rel="alternate" hreflang="{lang}" href="{url}" />',
        f'<link rel="alternate" hreflang="{other}" href="{alt_url}" />',
        f'<link rel="alternate" hreflang="x-default" href="{SITE_URL + page_path(mode, "th")}" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="DeepWorld" />',
        f'<meta property="og:title" content="{e(title)}" />',
        f'<meta property="og:description" content="{e(desc)}" />',
        f'<meta property="og:url" content="{url}" />',
        f'<meta property="og:locale" content="{OG_LOCALE[lang]}" />',
        f'<meta property="og:locale:alternate" content="{OG_LOCALE[other]}" />',
        f'<meta property="og:image" content="{SITE_URL}assets/og-image.jpg" />',
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        f'<meta property="og:image:alt" content="{e(title)}" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        f'<meta name="twitter:title" content="{e(title)}" />',
        f'<meta name="twitter:description" content="{e(desc)}" />',
        f'<meta name="twitter:image" content="{SITE_URL}assets/og-image.jpg" />',
        f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>',
    ]
    return '\n  '.join(lines)


def render(path):
    """index.html as served at `path` (a key of PAGES)."""
    mode, lang = PAGES[path]
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    start, end = src.index('<!-- seo:start -->'), src.index('<!-- seo:end -->')
    out = src[:start] + '<!-- seo:start -->\n  ' + seo_block(path) + '\n  ' + src[end:]
    out = out.replace('<html lang="th">', f'<html lang="{lang}">', 1)
    depth = path.count('/')
    if depth:
        out = out.replace('<head>', f'<head>\n  <base href="{"../" * depth}">', 1)
    return out


def sitemap():
    rows = []
    for path, (mode, lang) in PAGES.items():
        alts = ''.join(
            f'\n    <xhtml:link rel="alternate" hreflang="{l}" href="{SITE_URL + page_path(mode, l)}"/>' for l in ('th', 'en'))
        rows.append(f'  <url>\n    <loc>{SITE_URL + path}</loc>{alts}\n    <changefreq>monthly</changefreq>\n'
                    f'    <priority>{"1.0" if mode == "world" and lang == "th" else "0.8"}</priority>\n  </url>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
            + '\n'.join(rows) + '\n</urlset>\n')


def robots():
    return f'User-agent: *\nAllow: /\nDisallow: /tools/\n\nSitemap: {SITE_URL}sitemap.xml\n'


def build(out):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in ('src', 'data', 'assets'):
        shutil.copytree(ROOT / name, out / name)
    shutil.copy(ROOT / 'manifest.webmanifest', out / 'manifest.webmanifest')
    for path in PAGES:
        (out / path).mkdir(parents=True, exist_ok=True)
        (out / path / 'index.html').write_text(render(path), encoding='utf-8')
    (out / 'sitemap.xml').write_text(sitemap(), encoding='utf-8')
    (out / 'robots.txt').write_text(robots(), encoding='utf-8')
    (out / '.nojekyll').write_text('')


if __name__ == '__main__':
    if sys.argv[1:] == ['--update-index']:
        # Keep the committed index.html's SEO block (world, Thai) in sync with this file.
        p = ROOT / 'index.html'
        src = p.read_text(encoding='utf-8')
        start, end = src.index('<!-- seo:start -->'), src.index('<!-- seo:end -->')
        p.write_text(src[:start] + '<!-- seo:start -->\n  ' + seo_block('') + '\n  ' + src[end:], encoding='utf-8')
    else:
        build(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_site')

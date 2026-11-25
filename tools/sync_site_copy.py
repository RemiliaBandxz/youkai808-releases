#!/usr/bin/env python3
"""Website plugin copy comes from catalog.json (the same text the Hub shows), so the two never drift.

  python3 tools/sync_site_copy.py          rewrite the marked blocks in docs/index.html
  python3 tools/sync_site_copy.py --check  exit 1 if the site is stale or a public plugin's description is too thin

Blocks in docs/index.html: <!--copy:ID-->..<!--/copy:ID--> inside each Available Now card,
<!--free:start-->..<!--free:end--> and <!--soon:start-->..<!--soon:end--> grids.
Public = not beta. Beta-hidden plugins never reach the site.
"""
import html, json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CAT, SITE = os.path.join(ROOT, 'catalog.json'), os.path.join(ROOT, 'docs', 'index.html')
e = html.escape


def inside(p):
    lis = ''.join(f'<li>{e(f)}</li>' for f in p.get('features', []))
    return f'<details class="inside" open><summary>What\'s Inside</summary><ul>{lis}</ul></details>'


def copy(p):
    return f'<p class="lede">{e(p["tagline"])}</p><p>{e(p["about"])}</p>{inside(p)}'


def free_url(p):
    """Direct link to the newest Windows installer, so a free plugin needs no Hub and no account."""
    v = json.load(open(os.path.join(ROOT, p['versions']), encoding='utf-8'))
    return v['download_base'] + next(x['windows'] for x in v['versions'] if x['version'] == v['latest'])


ICONS = {"Vocal": "vocals", "Retune": "master", "Tapestop": "fx", "Beat": "beat", "Master": "master"}  # category keyword -> img/kd/icon_*.webp


def small_card(p, kind):
    icon = next((v for k, v in ICONS.items() if k in p['category']), 'fx')
    tags = f'<img class="badge" src="img/kd/badge_free.webp" alt="Free" width="84" height="28"><img class="cat" src="img/kd/icon_{icon}.webp" alt="" height="30"><span class="tag">{e(p["category"].replace("Free · ", ""))}</span>' if kind == 'free' \
        else f'<span class="tag">{e(p["category"])}</span>'
    btn = f'<a class="btn ghost" href="{e(free_url(p))}" download>Download</a>' if kind == 'free' else ''
    return (f'      <article class="card {kind}-card">\n'
            f'        <div class="shot"><img src="img/p/{p["id"]}.webp" alt="{e(p["name"])} plugin screenshot" loading="lazy"></div>\n'
            f'        <div class="body"><div class="tags">{tags}</div><h3>{e(p["name"])}</h3>{copy(p)}{btn}</div>\n'
            f'      </article>\n')


def problems(products):
    out = []
    for p in products:
        words = len(p.get('about', '').split())
        if not p.get('category'): out.append(f'{p["id"]}: no category')
        if p.get('wip'): out.append(f'{p["id"]}: WIP but public. Every "wip": true plugin must also be "beta": true (Remilia 2026-11-25: only show the ready ones)')
        if words < 40: out.append(f'{p["id"]}: about is only {words} words (40+ so it says what it does, the problem it fixes and where it goes)')
        if len(p.get('features', [])) < 4: out.append(f'{p["id"]}: needs 4+ features (real controls/presets from the plugin)')
        if len(p.get('tips', [])) < 2: out.append(f'{p["id"]}: needs 2+ tips')
        if not re.search(r'\bGoes (First|Last|On)\b', p.get('about', '')): out.append(f'{p["id"]}: about must say where it goes ("Goes Last On ...")')
        if not os.path.exists(os.path.join(ROOT, 'docs', 'img', 'p', p['id'] + '.webp')): out.append(f'{p["id"]}: missing docs/img/p/{p["id"]}.webp (run tools/sync_site_images.py)')
    return out


def render(src, products):
    def sub(pat, body, s):
        n = re.subn(pat, lambda m: m.group(1) + body + m.group(2), s, flags=re.S)
        if n[1] != 1: sys.exit(f'marker {pat!r} found {n[1]} times in docs/index.html')
        return n[0]
    buy = [p for p in products if p.get('price') and not p.get('wip') and not p.get('free')]
    for p in buy:
        src = sub(rf'(<!--copy:{p["id"]}-->).*?(<!--/copy:{p["id"]}-->)', copy(p), src)
    free = ''.join(small_card(p, 'free') for p in products if p.get('free') and not p.get('wip'))
    soon = ''.join(small_card(p, 'soon') for p in products if p.get('wip'))
    src = sub(r'(<!--free:start-->\n).*?(      <!--free:end-->)', free, src)
    return sub(r'(<!--soon:start-->\n).*?(      <!--soon:end-->)', soon, src)


if __name__ == '__main__':
    products = [p for p in json.load(open(CAT, encoding='utf-8'))['products'] if not p.get('beta')]
    old = open(SITE, encoding='utf-8').read()
    new = render(old, products)
    bad = problems(products)
    if '--check' in sys.argv:
        if new != old: bad.append('docs/index.html is out of date with catalog.json: run python3 tools/sync_site_copy.py')
        print('\n'.join(bad) or 'site copy OK'); sys.exit(1 if bad else 0)
    open(SITE, 'w', encoding='utf-8').write(new)
    print('\n'.join(bad) or f'synced {len(products)} public plugins')

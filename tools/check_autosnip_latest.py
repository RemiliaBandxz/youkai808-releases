#!/usr/bin/env python3
"""Fail if /download/autosnip (which serves autosnip-versions.json versions[0]) lags the newest autosnip-v* release."""
import json, re, sys, urllib.request
def key(v): return tuple(int(x) for x in v.split('.'))
m = json.load(open('autosnip-versions.json'))['versions'][0]
rels = json.load(urllib.request.urlopen('https://api.github.com/repos/RemiliaBandxz/youkai808-releases/releases?per_page=100'))
tags = [r['tag_name'][len('autosnip-v'):] for r in rels if re.fullmatch(r'autosnip-v\d+(\.\d+)*', r['tag_name']) and not r['draft'] and r['assets']]
newest = max(tags, key=key)
bad = []
if key(m['version']) < key(newest): bad.append(f"manifest {m['version']} lags newest release {newest}")
if m['windows'] != f'https://github.com/RemiliaBandxz/youkai808-releases/releases/download/autosnip-v{m["version"]}/AutoSnip-v{m["version"]}-Setup.exe': bad.append('windows URL is not the public release asset: ' + m['windows'])
if 'autosnip-versions.json' not in open('docs/download/autosnip/index.html').read(): bad.append('download page no longer reads the manifest')
print('\n'.join(bad) or f'download page serves newest AutoSnip {newest}'); sys.exit(1 if bad else 0)

#!/usr/bin/env python3
"""Rebuild docs/img/p/<id>.webp (website cards) from each catalog product's Hub image. Run after hub-art changes."""
import json
from PIL import Image
c = json.load(open('catalog.json'))
for p in c['products']:
    im = Image.open(p['image']).convert('RGB'); im.thumbnail((800, 800))
    im.save(f"docs/img/p/{p['id']}.webp", 'WEBP', quality=82)
    print(p['id'], im.size)

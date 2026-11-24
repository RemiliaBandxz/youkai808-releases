#!/usr/bin/env python3
"""Refresh Hub/site preview images from real plugin screenshots.
usage: python3 tools/update_hub_art.py <shots dir>
<shots dir> = output of youkai808-source tools/audit_kit.sh (renders every kit plugin headless, live graphic running).
Copies <Dir>.png -> hub-art/<id>.png for every catalog product that has a screenshot and points catalog.json at it."""
import json, os, sys
from PIL import Image
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); shots = sys.argv[1]
cat_path = os.path.join(root, "catalog.json"); cat = json.load(open(cat_path))
by_id = {f[:-4].lower(): f for f in os.listdir(shots) if f.endswith(".png") and "-" not in f}
done = []
for p in cat["products"]:
    f = by_id.get(p["id"])
    if not f: continue
    im = Image.open(os.path.join(shots, f)).convert("RGB")
    out = f"hub-art/{p['id']}.png"; im.save(os.path.join(root, out), optimize=True)
    old = p.get("image", "")
    if old and old != out and os.path.isfile(os.path.join(root, old)): os.remove(os.path.join(root, old))
    p["image"] = out; done.append(p["id"])
open(cat_path, "w").write(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
print(f"updated {len(done)} previews: {' '.join(done)}")

#!/usr/bin/env python3
# Release gate: every shop tile must have a real image, and WIP plugins must not expose an installer
# (except beta:true WIPs, which the Hub only installs with a YBETA- beta key; Remilia OK'd this 2026-11-24).
# Usage: python3 tools/check_catalog.py   (run from repo root before pushing a Hub/catalog change)
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errs = []
cat = json.load(open(os.path.join(root, "catalog.json")))
for p in cat.get("products", []):
    pid = p.get("id", "?")
    img = p.get("image", "")
    if not img:
        errs.append(f"{pid}: no 'image' field (tile would be blank)")
    elif not img.startswith("http") and not os.path.isfile(os.path.join(root, img)):
        errs.append(f"{pid}: image file missing: {img}")
    for c in p.get("clips", []):
        u = c.get("url", "")
        if u and not u.startswith("http") and not os.path.isfile(os.path.join(root, u)):
            errs.append(f"{pid}: clip file missing: {u}")
    if p.get("wip"):
        if "versions" in p and not p.get("beta"):   # beta WIPs install only with a YBETA- key (Hub 1.26+)
            errs.append(f"{pid}: WIP plugin must not have a 'versions' field (not installable)")
        if p.get("buy_url") or p.get("price"):
            errs.append(f"{pid}: WIP plugin must not have a price/buy_url")
    else:
        vf = p.get("versions", "")
        if vf and not vf.startswith("http") and not os.path.isfile(os.path.join(root, vf)):
            errs.append(f"{pid}: versions file missing: {vf}")
# no WIP installer zips should be public
wip_names = [p["name"].replace(" ", "") for p in cat.get("products", []) if p.get("wip") and not p.get("beta")]   # beta WIPs are key-gated in the Hub
rel = os.path.join(root, "releases")
if os.path.isdir(rel):
    for f in os.listdir(rel):
        for n in wip_names:
            if n.lower() in f.lower().replace(" ", ""):
                errs.append(f"WIP installer still public: releases/{f}")
import subprocess   # private plugins must never be public (tools/check_private.py)
if subprocess.run([sys.executable, os.path.join(root, "tools", "check_private.py")]).returncode:
    errs.append("private plugin leak (see above)")
if errs:
    print("CATALOG CHECK FAILED:")
    for e in errs: print("  -", e)
    sys.exit(1)
print(f"catalog check OK: {len(cat.get('products',[]))} products, all tile images present, WIP plugins locked down")

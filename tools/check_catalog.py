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
    elif not img.startswith("http"):   # a preview must show the plugin, not a bare background (youkaivocal.jpg was one, 2026-11-24)
        try:
            from PIL import Image, ImageStat
            im = Image.open(os.path.join(root, img)).convert("L").resize((176, 110))
            px = im.tobytes(); edges = sum(abs(a - b) > 40 for a, b in zip(px, px[1:]))
            if edges < 400: errs.append(f"{pid}: preview {img} looks blank ({edges} edges): use a real UI screenshot (tools/update_hub_art.py)")
        except ImportError: pass
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
# HIDDEN products (Remilia 2026-11-25: "Hide satori from EVERYONE"): not in the catalog, no versions file, no public
# installer, no site/account-page mention, no art. Every viewer, owner included. Unhide only if she asks.
HIDDEN = {"satori": ["satori", "mix assistant", "mixassistant", "youkai brain"]}
for hid, words in HIDDEN.items():
    if any(p.get("id") == hid for p in cat.get("products", []) + cat.get("programs", [])):
        errs.append(f"hidden product '{hid}' is back in catalog.json")
    for dirpath, _, files in os.walk(root):
        if "/.git" in dirpath or dirpath.endswith(".git"): continue
        for f in files:
            full = os.path.join(dirpath, f); rel_ = os.path.relpath(full, root)
            if any(w.replace(" ", "") in f.lower().replace(" ", "").replace("-", "") for w in words):
                errs.append(f"hidden product '{hid}' file is public: {rel_}")
            elif f.endswith((".json", ".html", ".js", ".md", ".txt")) and not rel_.startswith("tools/"):
                t = open(full, encoding="utf-8", errors="ignore").read().lower()
                if rel_ == "paddle-live-prices.json": t = t.replace("mix assistant (satori) hidden", "")
                for w in words:
                    if w in t: errs.append(f"hidden product '{hid}' named in {rel_} ('{w}')"); break
import subprocess   # private plugins must never be public (tools/check_private.py)
if subprocess.run([sys.executable, os.path.join(root, "tools", "check_private.py")]).returncode:
    errs.append("private plugin leak (see above)")
if errs:
    print("CATALOG CHECK FAILED:")
    for e in errs: print("  -", e)
    sys.exit(1)
print(f"catalog check OK: {len(cat.get('products',[]))} products, all tile images present, WIP plugins locked down")

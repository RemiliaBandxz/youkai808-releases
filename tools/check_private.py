#!/usr/bin/env python3
"""Private-plugin leak gate. Fails if any of Remilia's PRIVATE plugins (never in the Hub, store, beta,
WIP or website) shows up anywhere in this public repo: catalog.json, hub.json, *-versions.json, releases/,
hub-art/, hub-clips/, docs/ (the website), server/. Names are stored as hashes so this public file
doesn't itself leak them. The plain list lives in Z:\\VSTDEV\\PRIVATE-PLUGINS.md.
Exception (Remilia 2026-11-24): a catalog entry with "owner_only": true (Hub 1.44+ shows it only to the owner
account + all-access codes) may name a private plugin, together with its own image, versions file and the
installers that versions file lists. It must also be beta + wip with no price, and never appear in docs/ (website).
Usage: python3 tools/check_private.py            # scan (CI runs this on every push/PR)
       python3 tools/check_private.py --hash "New Plugin Name"   # print hash lines to add below"""
import hashlib, os, re, sys

def h(tok): return hashlib.sha256(("ykpriv:" + tok).encode()).hexdigest()[:20]

def tokens(text):
    out = set()
    for w in re.split(r"[^A-Za-z0-9]+", text):
        if not w: continue
        out.add(w.lower())
        out.update(p.lower() for p in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", w))  # CamelCase parts
    return out

PRIVATE = {  # hash -> plugin number in PRIVATE-PLUGINS.md (add with --hash; skip plain words like "crisp")
    "520f7ff763abcde4303b": 1, "f1612e261af9ae3d9db5": 1,  # 1 Funayurei Ride
    "1f84757f677403988376": 2, "1eaf5a0c8d66470ca852": 2,  # 2 Kamaitachi Crisp
    "32c7ada94b157d1ab6c6": 3, "eff697877c231efafc87": 3, "8afc840e55be3e56667c": 3, "01a10fbaa7a4a66e1865": 3,  # 3 Bandxzz Bend Tune (ex Rokurokubi Tune)
}
BINARY = (".exe", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".mp3", ".ogg", ".wav", ".mp4", ".zip", ".dmg", ".pkg", ".woff", ".woff2", ".ttf")

def owner_only(root):
    """(catalog text without owner_only entries, allowed file paths, rule errors)"""
    import json
    cat = json.load(open(os.path.join(root, "catalog.json"), encoding="utf-8"))
    allowed, errs, keep = set(), [], []
    for e in cat.get("products", []):
        if not e.get("owner_only"): keep.append(e); continue
        if not (e.get("beta") and e.get("wip")) or e.get("price") or e.get("buy_url") or e.get("store_product_ids"):
            errs.append(f"catalog.json: owner_only '{e.get('id')}' must be beta + wip with no price/buy_url/store ids")
        for k in ("image", "versions"):
            if e.get(k) and not e[k].startswith("http"): allowed.add(os.path.normpath(e[k]))
        vf = os.path.join(root, e.get("versions", ""))
        if os.path.isfile(vf):
            for v in json.load(open(vf)).get("versions", []):
                for k in ("windows", "mac"):
                    if v.get(k) and not v[k].startswith("http"): allowed.add(os.path.normpath(v[k]))
    cat["products"] = keep
    return json.dumps(cat), allowed, errs

def scan(root):
    cat_txt, allowed, hits = owner_only(root)
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
        for f in files:
            p = os.path.join(d, f); rel = os.path.relpath(p, root)
            if rel == os.path.join("tools", "check_private.py") or rel in allowed: continue
            toks = tokens(rel)
            if not f.lower().endswith(BINARY) and os.path.getsize(p) < 5_000_000:
                try: toks |= tokens(cat_txt if rel == "catalog.json" else open(p, encoding="utf-8").read())
                except UnicodeDecodeError: pass
            for t in toks:
                if h(t) in PRIVATE: hits.append(f"{rel}: private plugin #{PRIVATE[h(t)]} ('{t}')")
    return hits

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--hash":
        name = " ".join(sys.argv[2:])
        for t in sorted(tokens(name) | {re.sub(r"[^a-z0-9]", "", name.lower())}):
            if len(t) > 4: print(f'    "{h(t)}": N,  # {t}')
        sys.exit(0)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = scan(root)
    if hits:
        print("PRIVATE PLUGIN LEAK: these must never be public (Hub, store, beta, WIP or website):")
        for x in hits: print("  -", x)
        sys.exit(1)
    print(f"private check OK: none of the {len(set(PRIVATE.values()))} private plugins are in this repo")

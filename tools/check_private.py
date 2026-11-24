#!/usr/bin/env python3
"""Private-plugin leak gate. Fails if any of Remilia's PRIVATE plugins (never in the Hub, store, beta,
WIP or website) shows up anywhere in this public repo: catalog.json, hub.json, *-versions.json, releases/,
hub-art/, hub-clips/, docs/ (the website), server/. Names are stored as hashes so this public file
doesn't itself leak them. The plain list lives in Z:\\VSTDEV\\PRIVATE-PLUGINS.md.
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
    "32c7ada94b157d1ab6c6": 3, "eff697877c231efafc87": 3, "8afc840e55be3e56667c": 3,  # 3 Bandxzz (ex Rokurokubi Tune)
}
BINARY = (".exe", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".mp3", ".ogg", ".wav", ".mp4", ".zip", ".dmg", ".pkg", ".woff", ".woff2", ".ttf")

def scan(root):
    hits = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
        for f in files:
            p = os.path.join(d, f); rel = os.path.relpath(p, root)
            if rel == os.path.join("tools", "check_private.py"): continue
            toks = tokens(rel)
            if not f.lower().endswith(BINARY) and os.path.getsize(p) < 5_000_000:
                try: toks |= tokens(open(p, encoding="utf-8").read())
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

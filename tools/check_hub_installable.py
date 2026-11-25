#!/usr/bin/env python3
"""Pre-release gate: every PUBLIC catalog item (products + programs) must be installable by the CURRENT Hub.

  python3 tools/check_hub_installable.py            structure only (offline, fast)
  python3 tools/check_hub_installable.py --online   also fetch the first KB of each latest installer (must be a real .exe)

Why (2026-11-25): Remilia's Hub wouldn't install AutoSnip 0.3.1. The 297 MB release asset had no "size" in its versions
file, so a download that stalled part-way looked finished and the cut-off file was run. Now every installer needs a
size, and the Hub resumes a stalled download and refuses one that is short.
What the Hub (1.58+) understands, per versions file: latest + versions[].windows (repo path or https URL) or
windows_parts, and "size" (bytes, required for release-asset downloads). Programs (catalog "programs") also need silent_args + registry/uninstall_key so the
Hub can install quietly and read back the version.
"""
import json, os, sys, urllib.request
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
online = "--online" in sys.argv
cat = json.load(open(os.path.join(root, "catalog.json"), encoding="utf-8"))
errs, n = [], 0
progs = {p.get("id") for p in cat.get("programs", [])}

def public(p):
    return not (p.get("beta") or p.get("wip") or p.get("owner_only"))

def first_kb(url):
    req = urllib.request.Request(url, headers={"Range": "bytes=0-1023", "User-Agent": "youkai-hub-check"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read(1024)

for kind in ("products", "programs"):
    for p in cat.get(kind, []):
        pid = p.get("id", "?")
        if not public(p) or (kind == "products" and pid in progs):
            continue   # hidden items aren't offered; an app in both lists is installed from "programs"
        vf = p.get("versions", "")
        if not vf:
            errs.append(f"{pid}: public but has no 'versions' file (Hub can't install it)"); continue
        path = os.path.join(root, vf)
        if vf.startswith("http") or not os.path.isfile(path):
            errs.append(f"{pid}: versions file {vf} must be a file in this repo"); continue
        v = json.load(open(path, encoding="utf-8"))
        latest = next((x for x in v.get("versions", []) if x.get("version") == v.get("latest")), None)
        if latest is None:
            errs.append(f"{pid}: 'latest' {v.get('latest')} is not in its versions list"); continue
        urls = latest.get("windows_parts") or ([latest["windows"]] if latest.get("windows") else [])
        if not urls:
            errs.append(f"{pid} {v['latest']}: no windows download"); continue
        if not latest.get("size") and any(u.startswith("http") for u in urls):
            # in-repo installers get swapped in place by other threads; a stale size there would make the Hub refuse them
            errs.append(f"{pid} {v['latest']}: no 'size' (bytes) - a cut-off download can't be caught")
        if kind == "programs":
            if not p.get("silent_args"): errs.append(f"{pid}: program needs 'silent_args'")
            if not (p.get("registry") or p.get("uninstall_key")): errs.append(f"{pid}: program needs 'registry' or 'uninstall_key'")
        for u in urls:
            full = u if u.startswith("http") else v.get("download_base", "") + u
            if not u.startswith("http") and not os.path.isfile(os.path.join(root, u)):
                errs.append(f"{pid}: installer missing from repo: {u}")
            elif not u.startswith("http") and len(urls) == 1 and latest.get("size") and os.path.getsize(os.path.join(root, u)) != latest["size"]:
                errs.append(f"{pid}: 'size' {latest['size']} doesn't match {u} ({os.path.getsize(os.path.join(root, u))}) - the Hub would refuse it")
            elif online:
                try:
                    st, head = first_kb(full)
                    if st not in (200, 206) or (u is urls[0] and head[:2] != b"MZ"):
                        errs.append(f"{pid}: {full} -> HTTP {st}, not an .exe")
                except Exception as e:
                    errs.append(f"{pid}: {full} not downloadable ({e})")
        n += 1

# The Hub's own update (60 MB) is size-checked too: hub.size must match the committed setup or every Hub refuses it.
hub = cat.get("hub", {}); hf = os.path.join(root, "hub", "YoukaiDigitalHub-Setup.exe")
if hub.get("windows", "").endswith("hub/YoukaiDigitalHub-Setup.exe") and os.path.isfile(hf) and hub.get("size") != os.path.getsize(hf):
    errs.append(f"hub: catalog hub.size {hub.get('size')} != hub/YoukaiDigitalHub-Setup.exe ({os.path.getsize(hf)}) - update hub.size when you publish a Hub")

if errs:
    print("HUB-INSTALLABLE CHECK FAILED:"); [print("  -", e) for e in errs]; sys.exit(1)
print(f"hub-installable check OK: {n} public items" + (" (links verified online)" if online else ""))

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
import json, os, struct, sys, urllib.request
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
online = "--online" in sys.argv
cat = json.load(open(os.path.join(root, "catalog.json"), encoding="utf-8"))
errs, n = [], 0
progs = {p.get("id") for p in cat.get("programs", [])}

def public(p):
    return not (p.get("beta") or p.get("wip") or p.get("owner_only"))

def hub_ver(label):
    """Same as the Hub's parseVer: 2-4 numeric parts, minor/patch capped at 99. 0 = the Hub can't read it."""
    t = str(label).strip().lstrip("vV").split(".")
    if not 2 <= len(t) <= 4 or not all(x.isdigit() for x in t[:3]): return 0
    return int(t[0]) * 10000 + min(int(t[1]), 99) * 100 + (min(int(t[2]), 99) if len(t) > 2 else 0)

def rcdata_ids(path):
    """RT_RCDATA ids in a Windows exe. The Hub's plugin UPDATE pulls the VST3 out of RCDATA 101."""
    d = open(path, "rb").read()
    pe = struct.unpack_from("<I", d, 0x3c)[0]
    if d[pe:pe + 4] != b"PE\0\0": return []
    nsec, optsz = struct.unpack_from("<H", d, pe + 6)[0], struct.unpack_from("<H", d, pe + 20)[0]
    opt = pe + 24; dd = opt + (112 if struct.unpack_from("<H", d, opt)[0] == 0x20b else 96)
    rva = struct.unpack_from("<I", d, dd + 16)[0]; base = None
    for i in range(nsec):
        sh = opt + optsz + 40 * i; vs, va = struct.unpack_from("<II", d, sh + 8); raw = struct.unpack_from("<I", d, sh + 20)[0]
        if rva and va <= rva < va + max(vs, 1): base = raw + rva - va
    if base is None: return []
    ents = lambda off: [struct.unpack_from("<II", d, base + off + 16 + 8 * i) for i in range(sum(struct.unpack_from("<HH", d, base + off + 12)))]
    return next(([i for i, _ in ents(o & 0x7fffffff)] for n, o in ents(0) if n == 10 and o & 0x80000000), [])

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

# UPDATABLE (2026-11-25: Remilia stuck on AutoSnip 0.3.4, "Couldn't fetch the updates"). Every listed item, WIP included
# (the owner sees those): versions the Hub can read, newest first so an update is offered, and the right update path:
# an app (silent_args) must be in "programs" (old Hubs put a products-only app in the VST3 batch); a plugin's latest
# installer must carry the VST3 as RCDATA 101 or UPDATE EVERYTHING can't stage it.
for p in cat.get("products", []) + cat.get("programs", []):
    pid, vf = p.get("id", "?"), p.get("versions", "")
    if not vf or not os.path.isfile(os.path.join(root, vf)): continue
    v = json.load(open(os.path.join(root, vf), encoding="utf-8"))
    nums = [hub_ver(x.get("version", "")) for x in v.get("versions", [])]
    if 0 in nums: errs.append(f"{pid}: a version label the Hub can't read: {[x.get('version') for x in v['versions']]}")
    elif nums and (hub_ver(v.get("latest", "")) != max(nums) or len(set(nums)) != len(nums)):
        errs.append(f"{pid}: 'latest' {v.get('latest')} must be the single highest version, or the Hub won't offer the update")
    if p.get("silent_args") and (pid not in progs or p in cat.get("products", [])):
        errs.append(f"{pid}: an app (silent_args) belongs ONLY in catalog 'programs'; Hubs before 1.59 put a products-listed app in the VST3 batch and UPDATE EVERYTHING fails")
    latest = next((x for x in v.get("versions", []) if x.get("version") == v.get("latest")), {})
    w = latest.get("windows", "")
    if not p.get("silent_args") and w and not w.startswith("http") and not latest.get("windows_parts"):
        f = os.path.join(root, w)
        if os.path.isfile(f) and 101 not in rcdata_ids(f):
            errs.append(f"{pid} {v.get('latest')}: {w} has no VST3 payload (RCDATA 101); the Hub's UPDATE can't install it")

if errs:
    print("HUB-INSTALLABLE CHECK FAILED:"); [print("  -", e) for e in errs]; sys.exit(1)
print(f"hub-installable check OK: {n} public items" + (" (links verified online)" if online else ""))

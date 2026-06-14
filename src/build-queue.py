#!/usr/bin/env python3
# Filter discover.mjs output to in-scope jobs, dedupe vs tracker, and MERGE into
# config/queue.yaml: existing entries keep their status (never clobbered by a re-sweep); only
# genuinely new jobs are appended. All scoping comes from config/search.json (a JSON projection
# of profile.yaml's `search:` block, written by discover.mjs) — nothing here is hardcoded to a
# person or place. Usage:
#   node src/discover.mjs > /tmp/cands.json && python3 src/build-queue.py
import json, re, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def p(*a): return os.path.join(ROOT, *a)

CANDS = os.environ.get("CANDS", "/tmp/cands.json")
cands = json.load(open(CANDS))

# --- scoping config (from profile.yaml via discover.mjs) ---
try:
    SC = json.load(open(p("config", "search.json")))
except FileNotFoundError:
    SC = {}
TARGET_LOCS = SC.get("target_locations") or []
ACCEPT_REMOTE_US = SC.get("accept_remote_us", True)
EXCLUDE_LOCS = SC.get("exclude_locations") or []
EXCLUDE_TITLES = SC.get("exclude_titles_containing") or []
TARGET_ROLES = SC.get("target_roles") or []
EXCLUDE_TOO_SENIOR = SC.get("exclude_too_senior", True)

def comp(patterns):
    if not patterns:
        return re.compile(r"a^")  # matches nothing
    return re.compile("(" + "|".join(patterns) + ")", re.I)

TARGET_RE = comp(TARGET_LOCS)
EXCLUDE_LOC_RE = comp(EXCLUDE_LOCS)
EXCLUDE_TITLE_RE = comp(EXCLUDE_TITLES)
TARGET_ROLE_RE = comp(TARGET_ROLES) if TARGET_ROLES else None  # None => accept any title
TOO_SENIOR = re.compile(r"director|vice president|\bvp\b|principal|\bhead\b|chief|\bsvp\b|\bevp\b|partner|senior manager|sr\.? manager|\blead\b", re.I)
REMOTE = re.compile(r"remote|anywhere|distributed|work from home|wfh", re.I)
US = re.compile(r"\bunited states\b|\bu\.?s\.?a?\b|north america", re.I)
USONLY = re.compile(r"^(united states( of america)?|usa?|u\.s\.?a?\.?)[\s,|.-]*$", re.I)  # country-only

def scope(loc):
    """Return 'local' (names a target location), 'remote' (US-remote), or None (out of scope)."""
    l = loc or ""
    if TARGET_RE.search(l):
        return "local"
    if EXCLUDE_LOC_RE.search(l):
        return None  # excluded region and no target match
    if ACCEPT_REMOTE_US:
        if REMOTE.search(l):
            return "remote"
        if USONLY.match(l.strip()) or US.search(l):
            return "remote"
    return None

# --- dedupe vs tracker.csv (submitted/closed jobs never reappear) ---
done, done_urls = set(), set()
try:
    for line in open(p("tracker.csv")):
        m = re.search(r"jobs/(\d{6,})", line)
        if m:
            done.add(m.group(1))
        for mm in re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", line):
            done.add(mm)  # lever/ashby uuids
        for mm in re.findall(r"(https?://[^\s,\"]+)", line):
            done_urls.add(mm.strip().rstrip("/"))
except FileNotFoundError:
    pass

# --- existing queue entries: preserve verbatim (status edits survive re-sweeps) ---
existing_urls, existing_lines = set(), []
try:
    cur_entry = []
    for line in open(p("config", "queue.yaml")):
        if line.startswith("#"):
            continue
        if line.startswith("- "):
            if cur_entry:
                existing_lines.append(cur_entry)
            cur_entry = [line]
        elif cur_entry and line.strip():
            cur_entry.append(line)
            m = re.match(r"\s+url:\s*(\S+)", line)
            if m:
                existing_urls.add(m.group(1).rstrip("/"))
    if cur_entry:
        existing_lines.append(cur_entry)
except FileNotFoundError:
    pass

keep, seen = [], set()
for x in cands:
    if x.get("id") and str(x["id"]) in done:
        continue
    url = (x.get("url") or "").rstrip("/")
    if url in done_urls or url in existing_urls:
        continue
    x["role"] = x.get("role") or x.get("title") or ""
    if not x["role"] or not x.get("url"):
        continue
    if EXCLUDE_TITLE_RE.search(x["role"]):
        continue
    if EXCLUDE_TOO_SENIOR and TOO_SENIOR.search(x["role"]):
        continue
    if TARGET_ROLE_RE and not TARGET_ROLE_RE.search(x["role"]):
        continue
    sc = scope(x.get("location", ""))
    if not sc:
        continue
    if x["url"] in seen:
        continue
    seen.add(x["url"])
    x["scope"] = sc
    keep.append(x)

json.dump(keep, open("/tmp/inscope.json", "w"), indent=1)

# --- MERGE into config/queue.yaml: existing entries first (verbatim), then new ones ---
with open(p("config", "queue.yaml"), "w") as f:
    f.write("# Application queue, MERGED by src/build-queue.py from src/discover.mjs sweeps.\n")
    f.write("# Existing entries keep their status across re-sweeps; only new jobs are appended.\n")
    f.write("# ats: greenhouse|lever|ashby|smartrecruiters|workable. scope: local|remote.\n\n")
    for entry in existing_lines:
        f.writelines(entry)
    for x in sorted(keep, key=lambda r: (r["scope"] != "local", r["company"])):
        f.write(f"- company: {x['company']}\n")
        f.write(f"  role: {json.dumps(x.get('role') or '')}\n")
        f.write(f"  url: {x['url']}\n")
        f.write(f"  ats: {x['ats']}\n")
        f.write(f"  location: {json.dumps(x['location'])}\n")
        f.write(f"  scope: {x['scope']}\n")
        if x.get("id"):
            f.write(f"  id: \"{x['id']}\"\n")
        f.write("  status: ready\n")

local = [x for x in keep if x["scope"] == "local"]
print("kept existing:", len(existing_lines), "| NEW in-scope:", len(keep),
      " local:", len(local), " remote:", len(keep) - len(local))
for x in (local + [r for r in keep if r["scope"] == "remote"])[:40]:
    print("  [%s] %-16s | %-44s | %s" % (x["ats"][:2], x["company"], x["role"][:44], x["location"][:20]))

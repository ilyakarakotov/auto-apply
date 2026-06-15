#!/usr/bin/env python3
# Discovery method #2: query jobhive's pre-scraped job DATASET (not a live company sweep).
# jobhive (github.com/stapply-ai/ats-scrapers) publishes per-ATS parquet shards of millions of
# live ATS jobs at https://storage.stapply.ai/jobhive/v1/<ats>/jobs.parquet. We pull the five
# shards the apply pipeline can fill (greenhouse/lever/ashby/smartrecruiters/workable), filter to
# the target_roles + target_locations/accept_remote_us from config/search.json, and emit candidates
# in the SAME JSON shape src/discover.mjs produces so src/build-queue.py merges + dedupes them into
# config/queue.yaml unchanged.
#
# This complements the live discover.mjs sweep: the dataset surfaces roles at boards the slug lists
# miss and normalizes location/remote. It is the big win for SmartRecruiters & Workable, which have
# no universe rotation — the dataset surfaces SR/Workable jobs at companies we'd never have swept.
# Nothing here is hardcoded to a person or place; all scoping comes from config/search.json (a JSON
# projection of profile.yaml's `search:` block, written by src/discover.mjs).
#
# Needs duckdb (OPTIONAL — only for this dataset path): pip3 install --user duckdb
#
#   python3 src/discover-jobhive.py            # refresh shards if >12h old, emit /tmp/cands-jobhive.json
#   python3 src/discover-jobhive.py --no-fetch # use cached /tmp/jh/*.parquet
#   then: CANDS=/tmp/cands-jobhive.json python3 src/build-queue.py
import duckdb, json, os, re, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def p(*a): return os.path.join(ROOT, *a)

JH_DIR = '/tmp/jh'
BASE = 'https://storage.stapply.ai/jobhive/v1'
ATSES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']
MAX_AGE = 12 * 3600
OUT = os.environ.get('CANDS', '/tmp/cands-jobhive.json')
os.makedirs(JH_DIR, exist_ok=True)

# --- scoping config (from profile.yaml via discover.mjs) ---
try:
    SC = json.load(open(p('config', 'search.json')))
except FileNotFoundError:
    sys.stderr.write('config/search.json not found — run `node src/discover.mjs` once first '
                     '(it writes search.json from config/profile.yaml).\n')
    sys.exit(1)
TARGET_ROLES = SC.get('target_roles') or []
EXCLUDE_TITLES = SC.get('exclude_titles_containing') or []
TARGET_LOCS = SC.get('target_locations') or []
ACCEPT_REMOTE_US = SC.get('accept_remote_us', True)
EXCLUDE_LOCS = SC.get('exclude_locations') or []
EXCLUDE_TOO_SENIOR = SC.get('exclude_too_senior', True)

def alt(patterns):
    # Build a SQL-safe regexp alternation; escape single quotes for embedding in the query.
    if not patterns:
        return None
    return ('(' + '|'.join(patterns) + ')').replace("'", "''")

TITLE_RE = alt(TARGET_ROLES)                 # title must match one of these (None => any)
EXCLUDE_TITLE_RE = alt(EXCLUDE_TITLES)        # ...and none of these
LOC_RE = alt(TARGET_LOCS)                     # location names a target place
NON_US_RE = alt(EXCLUDE_LOCS)                 # out-of-scope region
TOO_SENIOR = (r'(director|vice president|\bvp\b|principal|\bhead\b|chief|\bsvp\b|\bevp\b|partner|'
              r'senior manager|sr\.? manager|\blead\b)')

def fetch(ats):
    dst = f'{JH_DIR}/{ats}.parquet'
    if '--no-fetch' in sys.argv: return dst
    if os.path.exists(dst) and (time.time() - os.path.getmtime(dst)) < MAX_AGE: return dst
    sys.stderr.write(f'fetching {ats} parquet...\n')
    # storage.stapply.ai 403s the default Python-urllib User-Agent; send a browser-like one.
    req = urllib.request.Request(f'{BASE}/{ats}/jobs.parquet',
                                 headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) jobhive-sync'})
    with urllib.request.urlopen(req) as r, open(dst, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk: break
            f.write(chunk)
    return dst

paths = []
for a in ATSES:
    try:
        paths.append(fetch(a))
    except Exception as e:
        sys.stderr.write(f'{a}: fetch failed ({e}) — skipped\n')
if not paths:
    sys.stderr.write('no shards available — nothing to query\n')
    json.dump([], open(OUT, 'w'))
    sys.exit(0)

con = duckdb.connect()

def src(p_):  # one SELECT per shard, UNION-ed below
    return f"SELECT url, apply_url, title, company, location, is_remote, country_iso FROM read_parquet('{p_}')"

# Coarse pre-filter in SQL to keep the scan cheap; build-queue.py applies the authoritative scope.
where = []
if TITLE_RE:
    where.append(f"regexp_matches(lower(title), '{TITLE_RE}')")
if EXCLUDE_TITLE_RE:
    where.append(f"NOT regexp_matches(lower(title), '{EXCLUDE_TITLE_RE}')")
if EXCLUDE_TOO_SENIOR:
    where.append(f"NOT regexp_matches(lower(title), '{TOO_SENIOR}')")
# location: a target-location match OR US-remote (when accepted) OR a US country code; and not a
# pure out-of-scope region. Empty location passes (build-queue.py decides scope downstream).
loc_ok = []
if LOC_RE:
    loc_ok.append(f"regexp_matches(lower(coalesce(location,'')), '{LOC_RE}')")
if ACCEPT_REMOTE_US:
    loc_ok.append("(coalesce(TRY_CAST(is_remote AS BOOLEAN),false) AND coalesce(country_iso,'US') IN ('US',''))")
    loc_ok.append("upper(coalesce(country_iso,'')) = 'US'")
loc_ok.append("coalesce(location,'') = ''")
where.append('(' + ' OR '.join(loc_ok) + ')')
if NON_US_RE:
    where.append(f"NOT regexp_matches(lower(coalesce(location,'')), '{NON_US_RE}')")

sql = ' UNION ALL '.join(src(p_) for p_ in paths)
clause = ('\n    AND '.join(where)) if where else 'TRUE'
rows = con.execute(f"""
  WITH j AS ({sql})
  SELECT url, apply_url, title, company, location, is_remote, country_iso FROM j
  WHERE {clause}
""").fetchall()

def parse(url, company):
    # returns (ats, slug, id, canonical_url) from a job url across the 5 applyable ATSes
    m = re.search(r'greenhouse\.io/(?:embed/job_app\?for=)?([^/?]+).*?jobs?/(\d{5,})', url)
    if m: return ('greenhouse', m.group(1), m.group(2), url)
    m = re.search(r'greenhouse\.io/([^/?]+)', url)
    if m: return ('greenhouse', m.group(1), '', url)
    m = re.search(r'lever\.co/([^/?]+)/([0-9a-f-]{36})', url)
    if m: return ('lever', m.group(1), m.group(2), url)
    m = re.search(r'ashbyhq\.com/([^/?]+)/([0-9a-f-]{36})', url)
    if m: return ('ashby', m.group(1), m.group(2), url)
    m = re.search(r'smartrecruiters\.com/([^/?]+)/(\d{6,})', url)
    if m: return ('smartrecruiters', m.group(1).lower(), m.group(2), url)
    m = re.search(r'workable\.com/j/([0-9A-Fa-f]{8,})', url)  # apply.workable.com/j/<shortcode>
    if m and company:
        slug = company.strip().lower()
        return ('workable', slug, m.group(1), f'https://apply.workable.com/{slug}/j/{m.group(1)}/')
    return (None, None, None, None)

out, seen = [], set()
for url, apply_url, title, company, location, is_remote, country in rows:
    u = url or apply_url
    if not u: continue
    ats, slug, jid, canon = parse(u, company)
    if not ats or not slug: continue
    key = canon.rstrip('/')
    if key in seen: continue
    seen.add(key)
    # is_remote can arrive from parquet as a real bool OR the string "false"/"true"; a non-empty
    # "false" is truthy in Python, so normalize explicitly before labeling the location "Remote".
    remote_flag = str(is_remote).strip().lower() in ('true', '1', 't', 'yes')
    out.append({'ats': ats, 'company': slug, 'id': jid, 'title': title, 'role': title,
                'location': location or ('Remote' if remote_flag else ''), 'url': canon})

json.dump(out, open(OUT, 'w'), indent=1)
sys.stderr.write(f'jobhive-dataset candidates: {len(out)} (from {len(rows)} filtered rows) -> {OUT}\n')

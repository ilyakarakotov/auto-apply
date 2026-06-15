// Broad ATS JSON sweep: Greenhouse + Lever + Ashby + SmartRecruiters + Workable.
// Company tokens live in config/companies.json (grow it however you like). All filters
// (titles, locations, sponsorship-exclusion) come from config/profile.yaml — nothing here is
// hardcoded to a person or city. Dedupes against tracker.csv. Prints JSON candidates to stdout
// (pipe to a file; don't paste into context), then build-queue.py applies the in-scope filter.
//
//   node src/discover.mjs > /tmp/cands.json && python3 src/build-queue.py
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- profile-driven filters --------------------------------------------------------------
let profile;
try { profile = YAML.parse(rd('config/profile.yaml')) || {}; }
catch { console.error('config/profile.yaml not found — copy config/profile.example.yaml or run `npm run init`.'); process.exit(1); }
const S = profile.search || {};
const reList = (arr, fallback = 'a^') => new RegExp('(' + ((arr && arr.length ? arr : [fallback]).join('|')) + ')', 'i');

const TITLE_RE = reList(S.target_roles, '.'); // a role's title must match one of these ('.' = any, when none configured)
const EXCLUDE_TITLE = reList(S.exclude_titles_containing); // ...and none of these
const TOO_SENIOR = /(director|vice president|\bvp\b|principal|\bhead\b|chief|\bsvp\b|\bevp\b|partner|senior manager|sr\.? manager|\blead\b)/i;
const useSeniorFilter = S.exclude_too_senior !== false;
// location: keep if it names a target location (or US-remote when accept_remote_us); drop if it
// names an excluded region UNLESS it also names a target location.
const locTerms = [...(S.target_locations || [])];
if (S.accept_remote_us !== false) locTerms.push('remote', 'anywhere', 'work from home', '\\bwfh\\b', 'united states', 'u\\.s\\.', '\\bus\\b', '\\busa\\b', 'north america');
const LOC_OK = reList(locTerms, '.'); // '.' => match anything if no locations configured
const NON_US = reList(S.exclude_locations); // a^ default => never matches
const NO_SPONSOR = reList(S.exclude_text); // job-description text that disqualifies a posting

// Emit a normalized JSON projection of the search block so build-queue.py (stdlib-only Python,
// no YAML dep) sees exactly the same scoping rules this sweep used. Always fresh.
try {
  fs.writeFileSync(path.join(ROOT, 'config/search.json'), JSON.stringify({
    target_locations: S.target_locations || [],
    accept_remote_us: S.accept_remote_us !== false,
    exclude_locations: S.exclude_locations || [],
    exclude_titles_containing: S.exclude_titles_containing || [],
    target_roles: S.target_roles || [],
    exclude_too_senior: S.exclude_too_senior !== false,
  }, null, 1));
} catch {}

// ---- dedupe vs already-tracked jobs --------------------------------------------------------
let trackerRaw = '';
try { trackerRaw = rd('tracker.csv'); } catch {}
const seenIds = new Set(), seenUrls = new Set();
for (const line of trackerRaw.split('\n')) {
  const m = line.match(/jobs\/(\d{6,})/); if (m) seenIds.add(m[1]); // greenhouse numeric ids
  for (const u of line.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) seenIds.add(u[0]); // lever/ashby uuids
  for (const u of line.matchAll(/https?:\/\/[^\s,"]+/g)) seenUrls.add(u[0].replace(/\/$/, ''));
}

const COMPANIES = JSON.parse(rd('config/companies.json'));
const GH = COMPANIES.greenhouse || [], LEVER = COMPANIES.lever || [], ASHBY = COMPANIES.ashby || [],
  SMART = COMPANIES.smartrecruiters || [], WORKABLE = COMPANIES.workable || [];

// UNIVERSE rotation (optional): config/companies-universe.json holds extra unproven slugs. Each
// run sweeps the curated lists fully PLUS a rotating batch of the universe (UNIVERSE_BATCH env:
// per-ATS count, default 1500; 'all' = full pass; 0 = off). Companies that yield an in-scope
// candidate get PROMOTED into companies.json permanently.
let UNI = { greenhouse: [], lever: [], ashby: [] };
let cursor = { greenhouse: 0, lever: 0, ashby: 0 };
const cursorPath = path.join(ROOT, 'config/.universe-cursor.json');
try { UNI = { ...UNI, ...JSON.parse(rd('config/companies-universe.json')) }; } catch {}
try { cursor = { ...cursor, ...JSON.parse(fs.readFileSync(cursorPath, 'utf8')) }; } catch {}
const RAW_BATCH = process.env.UNIVERSE_BATCH ?? '1500';
const uniBatch = (ats) => {
  const list = UNI[ats] || [];
  if (!list.length || RAW_BATCH === '0') return [];
  if (RAW_BATCH === 'all') return list;
  const n = Math.max(0, parseInt(RAW_BATCH, 10) || 0);
  const start = cursor[ats] % list.length;
  const batch = [];
  for (let i = 0; i < Math.min(n, list.length); i++) batch.push(list[(start + i) % list.length]);
  cursor[ats] = (start + n) % list.length;
  return batch;
};
const GH_U = uniBatch('greenhouse'), LEVER_U = uniBatch('lever'), ASHBY_U = uniBatch('ashby');

const out = [];
const tried = { gh: 0, lever: 0, ashby: 0, smart: 0, workable: 0 };

async function fetchJson(url, ms = 15000) {
  // abort must cover the BODY read too: GH content=true payloads can be MBs and a stalled body
  // read with the timer already cleared hangs the worker pool forever.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function pushCand(c) {
  if (c.id && seenIds.has(String(c.id))) return;
  if (c.url && seenUrls.has(String(c.url).replace(/\/$/, ''))) return;
  if (useSeniorFilter && TOO_SENIOR.test(c.title)) return;
  if (EXCLUDE_TITLE.test(c.title)) return;
  if (!TITLE_RE.test(c.title)) return;
  const loc = c.location || '';
  if (NON_US.test(loc) && !LOC_OK.test(loc.replace(NON_US, ''))) return; // foreign without a target match
  if (loc && !LOC_OK.test(loc)) return;
  if (c.content && NO_SPONSOR.test(c.content)) return;
  delete c.content;
  out.push(c);
}

function locScore(loc = '') {
  loc = loc.toLowerCase();
  if ((S.target_locations || []).some(t => new RegExp(t, 'i').test(loc))) return 5; // an explicit target location
  if (/remote/.test(loc) && /(us|united states|u\.s\.)/.test(loc)) return 4;
  if (/remote/.test(loc)) return 3;
  if (/(united states|u\.s\.|\bus\b)/.test(loc)) return 2;
  return 1;
}

async function sweepGH(co) {
  tried.gh++;
  const light = process.env.GH_LIGHT === '1'; // bulk universe passes: 10-100x smaller payloads
  const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${co}/jobs${light ? '' : '?content=true'}`);
  if (!j || !j.jobs) return;
  for (const job of j.jobs) {
    const content = (job.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ');
    pushCand({ ats: 'greenhouse', company: co, id: String(job.id), title: job.title,
      location: (job.location && job.location.name) || '', url: job.absolute_url, content });
  }
}
async function sweepLever(co) {
  tried.lever++;
  const j = await fetchJson(`https://api.lever.co/v0/postings/${co}?mode=json`);
  if (!Array.isArray(j)) return;
  for (const job of j) {
    pushCand({ ats: 'lever', company: co, id: job.id, title: job.text,
      location: (job.categories && job.categories.location) || '', url: job.hostedUrl,
      content: (job.descriptionPlain || '') });
  }
}
async function sweepAshby(co) {
  tried.ashby++;
  const j = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${co}?includeCompensation=true`);
  if (!j || !j.jobs) return;
  for (const job of j.jobs) {
    pushCand({ ats: 'ashby', company: co, id: job.id, title: job.title,
      location: job.location || '', url: job.jobUrl || job.applyUrl || '', content: (job.descriptionPlain || '') });
  }
}
async function sweepSmart(co) {
  tried.smart++;
  const j = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${co}/postings?limit=100`);
  if (!j || !j.content) return;
  for (const job of j.content) {
    const loc = job.location ? [job.location.city, job.location.region, job.location.country].filter(Boolean).join(', ') : '';
    pushCand({ ats: 'smartrecruiters', company: co, id: String(job.id), title: job.name,
      location: loc, url: `https://jobs.smartrecruiters.com/${co}/${job.id}`, content: '' });
  }
}
async function sweepWorkable(co) {
  tried.workable++;
  const j = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${co}?details=true`);
  const jobs = j && (j.jobs || (j.widget && j.widget.jobs));
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    pushCand({ ats: 'workable', company: co, id: String(job.shortcode || job.id), title: job.title,
      location: [job.city, job.state, job.country].filter(Boolean).join(', ') || (job.location || ''),
      url: job.url || job.application_url || `https://apply.workable.com/${co}/j/${job.shortcode}/`, content: '' });
  }
}

const jobs = [];
if (process.env.SKIP_CURATED !== '1') {
  for (const c of GH) jobs.push(() => sweepGH(c));
  for (const c of LEVER) jobs.push(() => sweepLever(c));
  for (const c of ASHBY) jobs.push(() => sweepAshby(c));
  for (const c of SMART) jobs.push(() => sweepSmart(c));
  for (const c of WORKABLE) jobs.push(() => sweepWorkable(c));
}
for (const c of GH_U) jobs.push(() => sweepGH(c));
for (const c of LEVER_U) jobs.push(() => sweepLever(c));
for (const c of ASHBY_U) jobs.push(() => sweepAshby(c));
// concurrency pool (gentle on each ATS API; thousands of boards in minutes, no 429 storms)
const POOL = Math.max(1, parseInt(process.env.SWEEP_CONCURRENCY || '48', 10));
let ji = 0, doneN = 0;
async function worker() {
  while (ji < jobs.length) {
    const mine = jobs[ji++];
    try { await mine(); } catch {}
    if (++doneN % 1000 === 0) console.error(`  swept ${doneN}/${jobs.length}...`);
  }
}
await Promise.all(Array.from({ length: POOL }, worker));

// PROMOTE universe companies that yielded a candidate into companies.json (and persist cursor)
try {
  const hit = { greenhouse: new Set(), lever: new Set(), ashby: new Set() };
  for (const c of out) if (hit[c.ats]) hit[c.ats].add(c.company);
  const uniSets = { greenhouse: new Set(UNI.greenhouse), lever: new Set(UNI.lever), ashby: new Set(UNI.ashby) };
  let promoted = 0;
  for (const ats of ['greenhouse', 'lever', 'ashby']) {
    COMPANIES[ats] = COMPANIES[ats] || [];
    for (const co of hit[ats]) if (uniSets[ats].has(co) && !COMPANIES[ats].includes(co)) { COMPANIES[ats].push(co); promoted++; }
    COMPANIES[ats].sort((a, b) => a.localeCompare(b)); // same comparator as harvest-tokens.mjs
  }
  if (promoted) fs.writeFileSync(path.join(ROOT, 'config/companies.json'), JSON.stringify(COMPANIES, null, 1) + '\n');
  fs.writeFileSync(cursorPath, JSON.stringify(cursor));
  if (promoted) console.error(`promoted ${promoted} universe companies into companies.json`);
} catch (e) { console.error('promote/cursor write failed: ' + e.message); }

// de-dupe by (company + normalized title), keeping the best location variant
const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byKey = new Map();
for (const c of out) {
  const key = c.company + '|' + norm(c.title);
  const prev = byKey.get(key);
  if (!prev || locScore(c.location) > locScore(prev.location)) byKey.set(key, c);
}
const final = [...byKey.values()].sort((a, b) => a.company.localeCompare(b.company));
console.error(`tried GH=${tried.gh} Lever=${tried.lever} Ashby=${tried.ashby} Smart=${tried.smart} Workable=${tried.workable} (incl universe GH=${GH_U.length} Lever=${LEVER_U.length} Ashby=${ASHBY_U.length}); candidates=${final.length}`);
console.log(JSON.stringify(final, null, 1));

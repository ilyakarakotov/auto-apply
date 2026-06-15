#!/usr/bin/env node
// Pull validated, currently-live ATS board slugs from the public jobhive project
// (github.com/stapply-ai/ats-scrapers) and merge any NEW ones into config/companies-universe.json.
// jobhive maintains per-ATS company CSVs (name,slug,url) scraped directly from the ATS platforms —
// higher signal than a generic crawl universe because every slug there is a live board jobhive
// actually fetched.
//
// The merged slugs flow through the EXISTING discovery machinery untouched: src/discover.mjs
// sweeps a rotating batch of companies-universe.json each run and PROMOTES any that yield an
// in-scope role into companies.json. So this script just feeds the funnel; it doesn't apply,
// filter, or touch the queue.
//
//   node src/sync-jobhive.mjs            # fetch + merge, print new-slug counts
//   node src/sync-jobhive.mjs --dry      # report only, write nothing
//
// Only greenhouse/lever/ashby are merged — those are the ATSes discover.mjs sweeps from the
// universe rotation. (jobhive also publishes workday/smartrecruiters/etc., but the universe
// rotation only covers GH/Lever/Ashby; src/discover-jobhive.py mines those other ATSes instead.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNI_FILE = path.join(ROOT, 'config/companies-universe.json');
const COMPANIES_FILE = path.join(ROOT, 'config/companies.json');
const DRY = process.argv.includes('--dry');
const ATSES = ['greenhouse', 'lever', 'ashby'];
const BASE = 'https://raw.githubusercontent.com/stapply-ai/ats-scrapers/main/ats-companies';

// companies-universe.json may not exist yet — start empty and create it on first merge.
let uni = {};
try { uni = JSON.parse(fs.readFileSync(UNI_FILE, 'utf8')); } catch {}
// companies.json (curated, proven slugs) is optional too — only used to avoid re-adding known ones.
let cj = {};
try { cj = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8')); } catch {}

// crude CSV slug extractor: header is `name,slug,url`; slug is col 2. Slugs are simple tokens
// (no embedded commas), and names may be quoted/contain commas, so anchor on the slug+url
// shape from the right rather than splitting col 0.
function slugsFromCsv(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // ...,<slug>,<url>  -> slug is the field just before the trailing URL
    const m = line.match(/,([A-Za-z0-9][A-Za-z0-9._-]*),https?:\/\//);
    if (m) { out.push(m[1].toLowerCase()); continue; }
    // fallback: plain 3-col split
    const parts = line.split(',');
    if (parts.length >= 2 && parts[1]) out.push(parts[1].trim().toLowerCase());
  }
  return out;
}

async function fetchCsv(ats) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(`${BASE}/${ats}.csv`, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

let totalNew = 0;
for (const ats of ATSES) {
  let csv;
  try { csv = await fetchCsv(ats); }
  catch (e) { console.error(`${ats}: fetch failed (${e.message}) — skipped`); continue; }
  const slugs = slugsFromCsv(csv);
  // dedupe against BOTH the curated list and the existing universe
  const have = new Set([...(cj[ats] || []), ...(uni[ats] || [])].map(s => String(s).toLowerCase()));
  const seen = new Set();
  const fresh = [];
  for (const s of slugs) {
    if (!s || have.has(s) || seen.has(s)) continue;
    seen.add(s); fresh.push(s);
  }
  uni[ats] = [...(uni[ats] || []), ...fresh].sort();
  totalNew += fresh.length;
  console.error(`${ats}: jobhive=${slugs.length} new=${fresh.length} (universe now ${uni[ats].length})`);
}

if (DRY) { console.error(`[dry] would add ${totalNew} new slugs`); process.exit(0); }
if (totalNew) {
  fs.writeFileSync(UNI_FILE, JSON.stringify(uni, null, 1));
  console.error(`merged ${totalNew} new jobhive slugs into companies-universe.json`);
} else {
  console.error('no new slugs to merge');
}

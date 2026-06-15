#!/usr/bin/env node
// Grows config/companies.json — the curated list of ATS board slugs that discover.mjs sweeps.
// Person-agnostic, dependency-free (global fetch). Two modes:
//
// 1) Extract board slugs from any text/HTML/URL dump (e.g. a saved web-search results page,
//    a sitemap, a jobs-aggregator export):
//      node src/harvest-tokens.mjs --extract /tmp/dump.txt
//    Greps the ATS careers-URL shapes (job-boards.greenhouse.io/<slug>, jobs.lever.co/<slug>,
//    jobs.ashbyhq.com/<slug>, jobs.smartrecruiters.com/<Co>, apply.workable.com/<sub>) and
//    MERGES (dedupe + sort) any new tokens. No probe — they came from live URLs.
//
// 2) Probe company-name guesses against the public GH/Lever/Ashby APIs and keep the hits:
//      node src/harvest-tokens.mjs --names /tmp/names.txt
//    One name per line (slugified into a few variants); a 200 with a real jobs[] payload =
//    live board, which gets appended. (--names covers Greenhouse/Lever/Ashby only; SmartRecruiters
//    and Workable have no name-probe API — add those via --extract or the jobhive dataset.)
//
// Wide-net workflow: run web searches like
//   site:job-boards.greenhouse.io "<your target role>" (<your city> OR remote)
//   site:jobs.lever.co  "<your target role>" ...
//   site:jobs.ashbyhq.com  "<your target role>" ...
// save the results page to a file, then `--extract` it. For sponsor/VC/startup name lists,
// put company names in a file and `--names`.
//
// Always dedupes against the existing companies.json. Prints a short per-ATS summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'config/companies.json');
const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

// Load (or seed) companies.json. Keep _readme and any extra keys verbatim; only the five ATS
// arrays are touched.
const ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'];
let db;
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch { db = {}; }
for (const a of ATS) if (!Array.isArray(db[a])) db[a] = [];

const known = Object.fromEntries(ATS.map(a => [a, new Set(db[a])]));
const added = Object.fromEntries(ATS.map(a => [a, []]));

// SmartRecruiters company ids are case-sensitive ("Visa"); every other ATS is lowercase.
const normTok = (ats, t) => ats === 'smartrecruiters' ? t : t.toLowerCase();
const addTok = (ats, raw) => {
  const tok = normTok(ats, raw);
  if (!tok || tok.length < 3) return;
  if (known[ats].has(tok)) return;
  known[ats].add(tok);
  added[ats].push(tok);
};

async function alive(url, pick) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (!r.ok) return false;
    return pick(await r.json());
  } catch { return false; }
}

// Turn a free-text company name into a few slug candidates.
const slugs = (name) => {
  const base = name.toLowerCase().trim();
  const a = base.replace(/[^a-z0-9]+/g, '');                          // "Stack Overflow" -> stackoverflow
  const b = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');   // stack-overflow
  const c = base.split(/[\s,]+/)[0].replace(/[^a-z0-9]/g, '');        // stack
  return [...new Set([a, b, c])].filter(s => s.length > 2);
};

if (get('--extract')) {
  const txt = fs.readFileSync(get('--extract'), 'utf8');
  // [regex, ats]; the capture group is the slug. Token stop-list rejects path noise.
  const STOP = /^(jobs|embed|sitemap|api|board|careers|company|companies|search|widget|j)$/i;
  const pats = [
    [/(?:job-boards|boards)\.greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)/g, 'greenhouse'],
    [/boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/g, 'greenhouse'],
    [/jobs\.lever\.co\/([\w-]+)/g, 'lever'],
    [/jobs\.ashbyhq\.com\/([\w%.-]+?)(?:\/|"|'|\s|$)/g, 'ashby'],
    [/jobs\.smartrecruiters\.com\/([\w-]+)/g, 'smartrecruiters'],
    [/api\.smartrecruiters\.com\/v1\/companies\/([\w-]+)/g, 'smartrecruiters'],
    [/apply\.workable\.com\/(?:api\/[\w/]*accounts\/)?([\w-]+)/g, 'workable'],
  ];
  for (const [re, ats] of pats) {
    for (const m of txt.matchAll(re)) {
      let tok;
      try { tok = decodeURIComponent(m[1]); } catch { tok = m[1]; }
      if (STOP.test(tok)) continue;
      addTok(ats, tok);
    }
  }
} else if (get('--names')) {
  const names = fs.readFileSync(get('--names'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    for (const s of slugs(name)) {
      if (!known.greenhouse.has(s) &&
          await alive(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, j => j && Array.isArray(j.jobs))) {
        addTok('greenhouse', s); break;
      }
      if (!known.lever.has(s) &&
          await alive(`https://api.lever.co/v0/postings/${s}?mode=json&limit=1`, j => Array.isArray(j))) {
        addTok('lever', s); break;
      }
      if (!known.ashby.has(s) &&
          await alive(`https://api.ashbyhq.com/posting-api/job-board/${s}`, j => j && Array.isArray(j.jobs))) {
        addTok('ashby', s); break;
      }
    }
  }
} else {
  console.error('Usage: harvest-tokens.mjs --extract <file> | --names <file>');
  process.exit(1);
}

for (const a of ATS) db[a] = [...known[a]].sort((x, y) => x.localeCompare(y));
fs.writeFileSync(FILE, JSON.stringify(db, null, 1) + '\n');

const total = ATS.reduce((n, a) => n + added[a].length, 0);
console.log(`added ${total}: ` + ATS.map(a => `${a}=${added[a].length}`).join(' '));
for (const a of ATS) if (added[a].length) console.log(`  ${a}: ${added[a].join(', ')}`);

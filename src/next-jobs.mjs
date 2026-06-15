#!/usr/bin/env node
// Emit the next N ready jobs as COMPACT JSON so a worker session never reads the
// whole 3000-line queue.yaml into context. Read-only (no writes, safe to run in parallel).
//
// Usage:
//   node src/next-jobs.mjs [N] [--scope local|remote] [--ats greenhouse|lever|ashby]
//   node src/next-jobs.mjs 6                      # next 6 ready jobs, any scope/ats
//   node src/next-jobs.mjs 8 --scope local        # local (target-location) jobs first
//
// A job is "ready" iff its queue status is exactly `ready` AND its url/id is not already
// in tracker.csv (belt-and-suspenders against a stale status). Anything mid-pipeline
// (FILLED-PENDING-SUBMIT, PAUSED-NEEDS-HUMAN, SUBMITTED, SKIPPED-*) is excluded, so a
// killed/restarted session never re-picks a job it already touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseObjects } from './lib/csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const n = parseInt(args.find(a => /^\d+$/.test(a)) || '6', 10);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const wantScope = get('--scope');
const wantAts = get('--ats');
const reverse = args.includes('--reverse');

// already-touched ids/urls from tracker (dedupe safety net)
// Only SUBMITTED and CLOSED-NOT-SUBMITTED rows count — skipped/paused/gated
// jobs should be re-processable when reset to ready in queue.yaml.
// tracker.csv columns: date,company,role,url,ats,resume_file,status,screenshot,notes,followup_status
// role/notes may contain commas/quotes, so parse it as real CSV (lib/csv.mjs) keyed by header
// instead of by fragile field positions.
const done = new Set();
try {
  const rows = parseObjects(fs.readFileSync(path.join(ROOT, 'tracker.csv'), 'utf8'));
  for (const r of rows) {
    if (r.status !== 'SUBMITTED' && r.status !== 'CLOSED-NOT-SUBMITTED') continue;
    const url = (r.url || '').replace(/\/$/, '');
    if (!url) continue;
    done.add(url);
    const idMatch = url.match(/(\d{6,})$/);
    if (idMatch) done.add(idMatch[1]);
  }
} catch (e) {}

let queue = [];
try { queue = YAML.parse(fs.readFileSync(path.join(ROOT, 'config/queue.yaml'), 'utf8')) || []; }
catch (e) { console.error('cannot parse queue.yaml:', e.message); process.exit(1); }

const out = [];
const jobList = reverse ? [...queue].reverse() : queue;
for (const j of jobList) {
  if (!j || (j.status || '').trim() !== 'ready') continue;
  if (wantScope && j.scope !== wantScope) continue;
  if (wantAts && j.ats !== wantAts) continue;
  const url = (j.url || '').replace(/\/$/, '');
  if (done.has(url) || (j.id && done.has(String(j.id)))) continue;
  out.push({ company: j.company, role: j.role, url: j.url, ats: j.ats, scope: j.scope, location: j.location });
  if (out.length >= n) break;
}

const readyTotal = queue.filter(j => j && (j.status || '').trim() === 'ready').length;
console.log(JSON.stringify({ ready_remaining: readyTotal, batch: out }, null, 2));

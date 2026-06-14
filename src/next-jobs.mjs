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
const done = new Set();
try {
  const tr = fs.readFileSync(path.join(ROOT, 'tracker.csv'), 'utf8');
  for (const line of tr.trim().split('\n')) {
    const fields = line.split(',');
    // CSV: date,company,role,url,ats,resume_path,status,file,notes
    // role can contain commas, so find url and status by pattern
    const urlMatch = line.match(/,((https?:[^,]+)),/);
    const statusMatch = line.match(new RegExp(urlMatch
      ? `,${urlMatch[1]},[^,]*,[^,]*,([^,]+),`
      : ''), 'i');
    if (!urlMatch) continue;
    const url = urlMatch[1].replace(/\/$/, '');
    // Parse status from position: ...url,ats,resume_path,status,file,notes
    // We need to find the ats field position. Known ATS values: greenhouse, lever, ashby, etc.
    const idx = line.indexOf(urlMatch[1]);
    const afterUrl = line.slice(idx + urlMatch[1].length); // ,<ats>,<resume_path>,<status>,...
    const parts = afterUrl.split(',');
    // parts[0] may be empty (comma before url), parts[1]=ats, parts[2]=resume_path, parts[3]=status
    const status = parts[3];
    if (status === 'SUBMITTED' || status === 'CLOSED-NOT-SUBMITTED') {
      done.add(url);
      const idMatch = url.match(/(\d{6,})$/);
      if (idMatch) done.add(idMatch[1]);
    }
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

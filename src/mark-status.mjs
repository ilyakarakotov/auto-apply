#!/usr/bin/env node
// Atomically set ONE queue entry's status in config/queue.yaml, in place, preserving every
// other line verbatim (block-based, same model as build-queue.py — no full reserialize).
// This is the dedup fix: the worker calls it the MOMENT a form is filled (and again on
// pause/submit), so a killed/restarted session never re-fills a job it already handled.
//
// Usage:
//   node src/mark-status.mjs --url <job-url> --status FILLED-PENDING-SUBMIT
//   node src/mark-status.mjs --id  <job-id>  --status PAUSED-NEEDS-HUMAN
// Conventional statuses: ready | FILLED-PENDING-SUBMIT | PAUSED-NEEDS-HUMAN |
//   SUBMITTED | SKIPPED-POOR-FIT | SKIPPED-NO-SPONSORSHIP | skipped-needs-login |
//   SKIPPED-CAPTCHA | SKIPPED-EMAIL-GATE | CLOSED-NOT-SUBMITTED
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const url = get('--url');
const id = get('--id');
const status = get('--status');
if (!status || (!url && !id)) { console.error('usage: mark-status.mjs (--url U | --id I) --status S'); process.exit(1); }

const file = path.join(ROOT, 'config/queue.yaml');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');

// find the entry block. A list item starts at column 0 with "- <key>:" (key order varies:
// build-queue.py writes company-first, but a YAML re-dump sorts keys so it's ats-first — match either).
const ENTRY = /^-\s+\w+:/;
let start = -1;
const needleUrl = url ? url.replace(/\/$/, '') : null;
for (let i = 0; i < lines.length; i++) {
  if (ENTRY.test(lines[i])) {
    // scan this block for a matching url/id
    let j = i + 1, hit = false;
    for (; j < lines.length && !ENTRY.test(lines[j]); j++) {
      if (needleUrl && lines[j].includes('url:') && lines[j].replace(/\/?\s*$/, '').includes(needleUrl)) hit = true;
      if (id && /\bid:\s*"?/.test(lines[j]) && lines[j].includes(String(id))) hit = true;
    }
    if (hit) { start = i; var end = j; break; }
  }
}
if (start < 0) { console.error('no queue entry matched'); process.exit(2); }

let replaced = false;
for (let k = start; k < end; k++) {
  if (/^\s*status:\s*/.test(lines[k])) { lines[k] = lines[k].replace(/(status:\s*).*/, `$1${status}`); replaced = true; break; }
}
if (!replaced) lines.splice(end, 0, `  status: ${status}`); // no status line: insert at block end

fs.writeFileSync(file, lines.join('\n'));
console.log(`set status=${status} for ${url || id}`);

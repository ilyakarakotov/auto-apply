#!/usr/bin/env node
// Retry an email-gated submit by re-fetching the FRESHEST valid verification code for a company,
// ignoring stale codes from earlier attempts.
//
// The email-verification gate (see CLAUDE.md) can fail on the first try: the code is slow to
// arrive, expires, or — on a shared inbox — an older code for a different company gets picked.
// This helper isolates the reusable core of a retry: poll the inbox for the company's CURRENT
// code, rejecting anything older than --fresh-minutes so a stale code is never re-submitted. It
// tries the subject-match strategy first (best for shared inboxes), then falls back to the
// company-key body match. The actual browser re-submit (typing the code, clicking submit) is
// driven by the agent / your filler — this script just hands back a trustworthy code and,
// optionally, flips the queue entry back to `ready` so the normal pipeline re-runs it.
//
// (Generalized from a project-internal orchestrator that re-drove a specific browser worker and a
// /tmp joblist. That browser/worker glue was environment-specific and is intentionally omitted;
// the portable, reusable part is "fetch the freshest correct code for a company, clear stale ones".)
//
// Uses config/email-imap.json (same creds as check-email-code.mjs).
//
// Usage:
//   node src/retry-email-run.mjs "<company display name>"                 # print fresh code JSON
//   node src/retry-email-run.mjs "<company>" --wait                       # poll IMAP up to 60s
//   node src/retry-email-run.mjs "<company>" --code-only                  # print ONLY the code
//   node src/retry-email-run.mjs "<company>" --fresh-minutes 5           # tighten the freshness window
//   node src/retry-email-run.mjs "<company>" --url <job-url> --reset      # also set queue status -> ready
//
// Output (non --code-only): JSON {found, code, subject, from, ageMinutes}
// Exit code: 0 if a fresh code was found, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { fileURLToPath } from 'node:url';
import { extractCode } from './check-email-code.mjs';
import { subjectMatches } from './get-code-by-subject.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WAIT_MS = 60_000;            // total poll budget for --wait
const POLL_MS = 5_000;             // gap between polls
const DEFAULT_FRESH_MIN = 10;      // reject codes older than this (a stale code never re-submits)

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
// The positional company arg must skip the VALUES of value-taking flags (--url, --fresh-minutes),
// or `--url <u> Acme` would pick "<u>" as the company.
const VALUE_FLAGS = new Set(['--url', '--fresh-minutes']);
function firstPositional(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    return a;
  }
  return '';
}
const company = firstPositional(args).trim();
const waitMode = args.includes('--wait');
const codeOnly = args.includes('--code-only');
const doReset = args.includes('--reset');
const url = get('--url');
const freshRaw = parseFloat(get('--fresh-minutes') || String(DEFAULT_FRESH_MIN));
const freshMin = Number.isFinite(freshRaw) && freshRaw > 0 ? freshRaw : DEFAULT_FRESH_MIN;

if (!company) {
  console.error('Usage: node src/retry-email-run.mjs "<company>" [--wait] [--code-only] [--fresh-minutes N] [--url <u> --reset]');
  process.exit(1);
}

// Company key for the body-match fallback: strip a trailing numeric token-suffix, lowercase.
const companyKey = company.toLowerCase().replace(/[0-9]+$/, '');

// Scan the inbox once. Only codes from the last `freshMin` minutes qualify, so a stale code left
// over from a prior attempt is discarded ("clearing stale ones"). Prefer a subject-matched mail
// (shared-inbox safe), then a company-named body; mail that names neither in subject nor body is skipped.
async function pollFresh(client) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const cutoff = Date.now() - freshMin * 60 * 1000;
    const hits = [];
    for await (const msg of client.fetch({ since: new Date(cutoff) }, { source: true, envelope: true })) {
      const subject = msg.envelope?.subject || '';
      const dateMs = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : Date.now();
      if (dateMs < cutoff) continue;                       // stale -> drop
      const raw = msg.source?.toString() || '';
      const code = extractCode(raw);
      if (!code) continue;
      const subjHit = subjectMatches(subject, company);
      const bodyHit = companyKey.length > 2 && (subject + ' ' + raw).toLowerCase().includes(companyKey);
      if (!subjHit && !bodyHit) continue;
      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      hits.push({ uid: msg.uid, dateMs, subject, from, code, subjHit, bodyHit });
    }
    if (!hits.length) return { found: false, code: null, subject: null, from: null, ageMinutes: null };
    hits.sort((a, b) => (b.subjHit - a.subjHit) || (b.bodyHit - a.bodyHit) || (b.uid - a.uid));
    const top = hits[0];
    return {
      found: true,
      code: top.code,
      subject: top.subject,
      from: top.from,
      ageMinutes: Math.round((Date.now() - top.dateMs) / 60000),
    };
  } finally {
    lock.release();
  }
}

let creds;
try {
  creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/email-imap.json'), 'utf8'));
} catch {
  console.error('config/email-imap.json not found. Create it with {user, password, host, port}.');
  process.exit(1);
}

const client = new ImapFlow({
  host: creds.host || 'imap.gmail.com',
  port: creds.port || 993,
  secure: true,
  auth: { user: creds.user || creds.email, pass: creds.password || creds.pass },
  logger: false,
});

(async () => {
  await client.connect();
  let res;
  try {
    const deadline = Date.now() + (waitMode ? WAIT_MS : 0);
    for (;;) {
      try {
        res = await pollFresh(client);
      } catch (err) {
        res = { found: false, code: null, subject: null, from: null, ageMinutes: null, _err: err.message };
      }
      if (res.found || !waitMode || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Optionally reset the queue entry to `ready` so the normal pipeline re-runs the submit.
  if (res.found && doReset && url) {
    try {
      execFileSync('node', [path.join(ROOT, 'src/mark-status.mjs'), '--url', url, '--status', 'ready'],
        { stdio: 'inherit' });
    } catch (e) {
      console.error(`WARN: could not reset queue status for ${url}: ${e.message}`);
    }
  }

  if (codeOnly) {
    if (res.found) process.stdout.write(res.code);   // ONLY the code; empty string when none
  } else {
    console.log(JSON.stringify({
      found: res.found, code: res.code, subject: res.subject, from: res.from, ageMinutes: res.ageMinutes,
    }));
  }
  process.exit(res.found ? 0 : 1);
})().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});

#!/usr/bin/env node
// Fetch the email-verification code whose SUBJECT matches a company's DISPLAY name.
//
// Companion to src/check-email-code.mjs. When several applications are in flight against ONE
// shared inbox, multiple verification codes can land within the same lookback window — and the
// "newest" one is not necessarily the one you need. Greenhouse (and similar ATSes) name the
// brand in the subject ("Security code for your application to Acme"), so matching on the SUBJECT
// instead of just taking the freshest mail resolves that cross-company collision.
//
// Uses the SAME config/email-imap.json creds and the SAME code-extraction helpers as
// check-email-code.mjs (imported, not re-implemented). config/email-imap.json:
//   { "user": "you@gmail.com", "password": "<app password>", "host": "imap.gmail.com", "port": 993 }
// (For Gmail, create an App Password; do not use your login password.) That file is gitignored.
//
// Usage:
//   node src/get-code-by-subject.mjs "<company display name>"               # one check, print JSON
//   node src/get-code-by-subject.mjs "<company display name>" --wait        # poll IMAP up to 60s
//   node src/get-code-by-subject.mjs "<company display name>" --code-only   # print ONLY the code
//
// Output (non --code-only): JSON {found, code, subject, from}
// Exit code: 0 if a code was found, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { fileURLToPath } from 'node:url';
import { extractCode } from './check-email-code.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WAIT_MS = 60_000;              // total poll budget for --wait
const POLL_MS = 5_000;               // gap between polls
const LOOKBACK_MS = 15 * 60 * 1000;  // only consider mail from the last 15 minutes

// Reduce a display name to comparable tokens: drop legal suffixes / punctuation so
// "Acme, Inc." in the queue still matches "Acme" in the subject, and vice-versa.
export function nameTokens(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[0-9]+$/, '')   // drop a trailing numeric slug suffix (digitalocean98 -> digitalocean)
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the|technologies|labs|group|holdings)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 2);
}

// Does this subject plausibly belong to `company`? True when the subject contains the whole
// (normalized) name, OR shares a distinctive token with it. Requires the mail to look like a
// code email so a generic "thank you for applying to Acme" doesn't win over the real code.
export function subjectMatches(subject, company) {
  const subj = (subject || '').toLowerCase();
  const looksLikeCode = /security code|verification code|verify|confirm your|enter the .*code|your .*code/i.test(subject || '');
  if (!looksLikeCode) return false;
  const toks = nameTokens(company);
  if (!toks.length) return true;                 // no usable name -> match any code email
  if (subj.includes(toks.join(' '))) return true;
  return toks.some(t => subj.includes(t));
}

// Scan the inbox once for a code whose subject matches `company`. Returns the freshest match.
export async function pollOnceBySubject(client, company) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const hits = [];
    for await (const msg of client.fetch({ since }, { source: true, envelope: true })) {
      const subject = msg.envelope?.subject || '';
      if (!subjectMatches(subject, company)) continue;
      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      const code = extractCode(msg.source?.toString() || '');
      if (code) hits.push({ uid: msg.uid, from, subject, code });
    }
    if (!hits.length) return { found: false, code: null, subject: null, from: null };
    hits.sort((a, b) => b.uid - a.uid);          // freshest first (uid is monotonic per mailbox)
    const top = hits[0];
    return { found: true, code: top.code, subject: top.subject, from: top.from };
  } finally {
    lock.release();
  }
}

// ---- CLI entry (runs only when invoked directly, not when imported) ----
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const company = (args.find(a => !a.startsWith('--')) || '').trim();
  const waitMode = args.includes('--wait');
  const codeOnly = args.includes('--code-only');

  if (!company) {
    console.error('Usage: node src/get-code-by-subject.mjs "<company display name>" [--wait] [--code-only]');
    process.exit(1);
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
    try {
      const deadline = Date.now() + (waitMode ? WAIT_MS : 0);
      let res;
      for (;;) {
        try {
          res = await pollOnceBySubject(client, company);
        } catch (err) {
          res = { found: false, code: null, subject: null, from: null, _err: err.message };
        }
        if (res.found || !waitMode || Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
      }
      if (codeOnly) {
        if (res.found) process.stdout.write(res.code);   // ONLY the code; empty string when none
      } else {
        console.log(JSON.stringify({ found: res.found, code: res.code, subject: res.subject, from: res.from }));
      }
      process.exit(res.found ? 0 : 1);
    } finally {
      await client.logout().catch(() => {});
    }
  })().catch(err => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}

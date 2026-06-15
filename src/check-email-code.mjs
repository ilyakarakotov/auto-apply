#!/usr/bin/env node
// Fetch a Greenhouse-style 8-char email-verification code from your job-applications inbox so the
// pipeline can clear the post-submit "enter the code we emailed you" gate instead of skipping it.
//
// This ONLY works because the form's email is your identity.email (config/profile.yaml) AND that
// same inbox is configured here via IMAP — the code is sent to whatever address the form carries,
// so the form email and this inbox MUST match. Configure config/email-imap.json:
//   { "user": "you@gmail.com", "password": "<app password>", "host": "imap.gmail.com", "port": 993 }
// (For Gmail, create an App Password; do not use your login password.) This file is gitignored.
//
// Usage:
//   node src/check-email-code.mjs <company>               # one check, print JSON
//   node src/check-email-code.mjs <company> --wait        # poll IMAP up to 60s
//   node src/check-email-code.mjs <company> --code-only   # print ONLY the code (empty if none)
//
// Output (non --code-only): JSON {found, code, subject, from}
// Exit code: 0 if a code was found, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import {ImapFlow} from 'imapflow';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WAIT_MS = 60_000;              // total poll budget for --wait
const POLL_MS = 5_000;               // gap between polls
const LOOKBACK_MS = 15 * 60 * 1000;  // only consider mail from the last 15 minutes

// A valid Greenhouse code: exactly 8 mixed-case alphanumerics with at least one LETTER (rejects
// pure-digit dates like 20260613). Codes ARE case-sensitive and can be all-letters with no digit
// (e.g. TOxJKaMC) or mixed (e.g. UgA1AmJp) — so do NOT require a digit, and do NOT match
// uppercase-only; both mistakes silently drop real codes. Precision comes from the anchored
// "paste this code...:" match in extractCode; the keyword-proximity sort is only the fallback.
const STRICT = /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8}$/;
const CANDIDATE = /\b[A-Za-z0-9]{8}\b/g;
const KEYWORD = /verification|confirm|security|\bcode\b/gi;

// ---- pure helpers (no side effects; exported for unit tests) ----

// Decode a raw MIME message enough to read the visible body: drop the top-level header block
// (DKIM/ARC/Received noise), undo quoted-printable soft breaks, strip HTML tags/entities.
export function normalizeBody(raw) {
  let sep = raw.indexOf('\r\n\r\n');
  let skip = 4;
  if (sep < 0) { sep = raw.indexOf('\n\n'); skip = 2; }
  const body = sep > -1 ? raw.slice(sep + skip) : raw;
  return body
    .replace(/=\r?\n/g, '')                         // quoted-printable soft line breaks
    .replace(/=3D/gi, '=')                          // common QP artifact
    .replace(/<[^>]+>/g, ' ')                       // strip HTML tags
    .replace(/&nbsp;|&#160;|&zwnj;|&#8203;/gi, ' ') // strip the entities that hug codes
    .replace(/[ \t]+/g, ' ');
}

export function extractCode(raw) {
  const text = normalizeBody(raw);
  // PRIMARY: Greenhouse states the code right after a fixed anchor phrase, e.g.
  // "paste this code into the security code field on your application: TOxJKaMC".
  // Anchoring on that beats proximity ranking, which can mis-pick a base64 fragment
  // (e.g. an inline-attachment token) that happens to sit near the word "code".
  const anchored = text.match(/(?:paste this code[^:]*|your (?:security |verification )?code(?: is)?)[:\s]+([A-Za-z0-9]{8})\b/i);
  if (anchored && STRICT.test(anchored[1])) return anchored[1];
  const cands = [];
  let m;
  while ((m = CANDIDATE.exec(text)) !== null) {
    if (STRICT.test(m[0])) cands.push({code: m[0], idx: m.index});
  }
  if (!cands.length) return null;
  // A genuine verification email always NAMES the code ("verification"/"security"/"code"/
  // "confirm"). With no such keyword anywhere, an 8-char token is just an English word
  // (e.g. "applying") or a reference id — not a code. Don't return a false positive.
  const kw = [];
  let k;
  while ((k = KEYWORD.exec(text)) !== null) kw.push(k.index);
  if (!kw.length) return null;
  // Prefer the candidate nearest a verification keyword — the real code sits next to
  // "verification code" / "security code".
  const dist = i => Math.min(...kw.map(p => Math.abs(p - i)));
  cands.sort((a, b) => dist(a.idx) - dist(b.idx));
  return cands[0].code;
}

// Scan the inbox once for a verification code relevant to `companyKey`.
export async function pollOnce(client, companyKey) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const hits = [];
    for await (const msg of client.fetch({since}, {source: true, envelope: true})) {
      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      const subject = msg.envelope?.subject || '';
      const raw = msg.source?.toString() || '';
      const hay = (subject + ' ' + raw).toLowerCase();
      const companyHit = companyKey.length > 2 && hay.includes(companyKey);
      const greenhouseHit =
        from.includes('greenhouse') ||
        hay.includes('greenhouse') ||
        /verification|verify|security code|confirm your/i.test(subject);
      if (!companyHit && !greenhouseHit) continue;   // unrelated mail in the inbox
      const code = extractCode(raw);
      // A genuine code email announces itself in the subject ("Security code for your
      // application to X"). Confirmation / "thank you for applying" mails can still yield a
      // spurious 8-char token via the proximity fallback, so rank real code-subject mails first.
      const isCodeEmail = /security code|verification code|enter the .*code|your .*code/i.test(subject);
      if (code) hits.push({uid: msg.uid, from, subject, code, companyHit, isCodeEmail});
    }
    if (!hits.length) return {found: false, code: null, subject: null, from: null};
    // Prefer a real code-subject email, then a company-named one, then the newest, so a later
    // confirmation email or two near-simultaneous codes don't cross.
    hits.sort((a, b) => (b.isCodeEmail - a.isCodeEmail) || (b.companyHit - a.companyHit) || (b.uid - a.uid));
    const top = hits[0];
    return {found: true, code: top.code, subject: top.subject, from: top.from};
  } finally {
    lock.release();
  }
}

// ---- CLI entry (runs only when invoked directly, not when imported for tests) ----
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const company = (args.find(a => !a.startsWith('--')) || '').trim();
  const waitMode = args.includes('--wait');
  const codeOnly = args.includes('--code-only');

  if (!company) {
    console.error('Usage: node src/check-email-code.mjs <company> [--wait] [--code-only]');
    process.exit(1);
  }

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/email-imap.json'), 'utf8'));
  } catch {
    console.error('config/email-imap.json not found. Create it with {user, password, host, port}.');
    process.exit(1);
  }

  // Company token may carry a numeric suffix (e.g. "digitalocean98"); strip it for body matching.
  const companyKey = company.toLowerCase().replace(/[0-9]+$/, '');

  const client = new ImapFlow({
    host: creds.host || 'imap.gmail.com',
    port: creds.port || 993,
    secure: true,
    auth: {user: creds.user || creds.email, pass: creds.password || creds.pass},
    logger: false,
  });

  (async () => {
    await client.connect();
    try {
      const deadline = Date.now() + (waitMode ? WAIT_MS : 0);
      let res;
      for (;;) {
        try {
          res = await pollOnce(client, companyKey);
        } catch (err) {
          res = {found: false, code: null, subject: null, from: null, _err: err.message};
        }
        if (res.found || !waitMode || Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
      }
      if (codeOnly) {
        if (res.found) process.stdout.write(res.code);   // ONLY the code; empty string when none
      } else {
        console.log(JSON.stringify({found: res.found, code: res.code, subject: res.subject, from: res.from}));
      }
      process.exit(res.found ? 0 : 1);
    } finally {
      await client.logout().catch(() => {});
    }
  })().catch(err => {
    console.error(JSON.stringify({error: err.message}));
    process.exit(1);
  });
}

// Unit tests for the pure code-extraction helpers in src/check-email-code.mjs.
// These cover the anchored "paste this code" match, the verification-keyword
// proximity fallback, rejection of pure-digit dates, acceptance of all-letter
// and mixed 8-char codes, and normalizeBody's HTML / quoted-printable / header
// stripping. No IMAP / network is touched — only the exported pure functions.
//
//   node --test test/check-email-code.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBody, extractCode } from '../src/check-email-code.mjs';

test('extractCode: anchored "paste this code ...:" wins over nearby tokens', () => {
  const raw = [
    'From: no-reply@greenhouse.io',
    'Subject: Security code for your application',
    '',
    'To finish applying, paste this code into the security code field on your application: ABCdefgh',
    'Reference 20260613 token base64XYZ for tracking only.',
  ].join('\r\n');
  assert.equal(extractCode(raw), 'ABCdefgh');
});

test('extractCode: proximity fallback picks the token nearest "verification code"', () => {
  // No anchor phrase; the date-like token appears first, the real code sits next
  // to the keyword. Proximity ranking should select the keyword-adjacent code.
  const raw = [
    'Subject: Please verify',
    '',
    'Unrelated reference QQQQ1111 earlier in the body.',
    'Your verification code: UgA1AmJp',
  ].join('\r\n');
  assert.equal(extractCode(raw), 'UgA1AmJp');
});

test('extractCode: rejects pure-digit dates like 20260613', () => {
  const raw = 'Subject: notice\r\n\r\nSent on 20260613 with no real code present.';
  assert.equal(extractCode(raw), null);
});

test('extractCode: accepts an all-letter 8-char code (TOxJKaMC)', () => {
  const raw = 'Subject: code\r\n\r\nYour security code is TOxJKaMC for this application.';
  assert.equal(extractCode(raw), 'TOxJKaMC');
});

test('extractCode: accepts a mixed alphanumeric 8-char code (UgA1AmJp)', () => {
  const raw = 'Subject: code\r\n\r\nPlease paste this code: UgA1AmJp';
  assert.equal(extractCode(raw), 'UgA1AmJp');
});

test('extractCode: returns null when there is no valid candidate', () => {
  const raw = 'Subject: hi\r\n\r\nThanks for applying. We will be in touch soon.';
  assert.equal(extractCode(raw), null);
});

test('normalizeBody: drops the header block, undoes quoted-printable, strips HTML', () => {
  const raw = [
    'Received: from mx.example.com',
    'DKIM-Signature: v=1; a=rsa-sha256',
    'Subject: Security code',
    '',
    '<p>Your code is <b>TOxJKaMC</b>&nbsp;now.</p>',
    'wrapped li=',
    'ne continues',
  ].join('\r\n');
  const body = normalizeBody(raw);
  // Header lines are gone.
  assert.ok(!body.includes('DKIM-Signature'));
  assert.ok(!body.includes('Received:'));
  // HTML tags and the &nbsp; entity are stripped to spaces.
  assert.ok(!body.includes('<b>'));
  assert.ok(!body.includes('&nbsp;'));
  assert.ok(body.includes('TOxJKaMC'));
  // Quoted-printable soft break is rejoined ("li=\nne" -> "line").
  assert.ok(body.includes('line continues'));
});

test('normalizeBody: extractCode reads through HTML markup', () => {
  const raw = [
    'Subject: Security code for your application',
    '',
    '<div>paste this code into the security code field on your application:&nbsp;<strong>ABCdefgh</strong></div>',
  ].join('\r\n');
  assert.equal(extractCode(raw), 'ABCdefgh');
});

// Tests for src/lib/csv.mjs — RFC4180-ish round-trips: fields with commas, quotes, newlines.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseObjects, stringifyRow } from '../src/lib/csv.mjs';

test('parse: simple rows', () => {
  assert.deepEqual(parse('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parse: trailing newline does not add an empty row', () => {
  assert.deepEqual(parse('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('parse: empty input -> []', () => {
  assert.deepEqual(parse(''), []);
});

test('parse: quoted field with embedded comma', () => {
  assert.deepEqual(parse('a,"x,y",c'), [['a', 'x,y', 'c']]);
});

test('parse: escaped "" quotes inside a quoted field', () => {
  assert.deepEqual(parse('"she said ""hi""",z'), [['she said "hi"', 'z']]);
});

test('parse: quoted field with embedded newline', () => {
  assert.deepEqual(parse('a,"line1\nline2",c'), [['a', 'line1\nline2', 'c']]);
});

test('parse: CRLF line endings', () => {
  assert.deepEqual(parse('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('parse: empty fields preserved', () => {
  assert.deepEqual(parse('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parse(',,'), [['', '', '']]);
});

test('parseObjects: keys rows by header', () => {
  const text = 'date,company,role,url\n2026-06-14,Acme,"Engineer, Senior",https://x';
  assert.deepEqual(parseObjects(text), [
    { date: '2026-06-14', company: 'Acme', role: 'Engineer, Senior', url: 'https://x' },
  ]);
});

test('parseObjects: short rows fill missing trailing columns with ""', () => {
  const text = 'a,b,c\n1,2';
  assert.deepEqual(parseObjects(text), [{ a: '1', b: '2', c: '' }]);
});

test('parseObjects: header only -> []', () => {
  assert.deepEqual(parseObjects('a,b,c'), []);
});

test('stringifyRow: quotes only fields that need it', () => {
  assert.equal(stringifyRow(['a', 'b', 'c']), 'a,b,c');
  assert.equal(stringifyRow(['a', 'x,y', 'c']), 'a,"x,y",c');
  assert.equal(stringifyRow(['a', 'say "hi"']), 'a,"say ""hi"""');
  assert.equal(stringifyRow(['a', 'line1\nline2']), 'a,"line1\nline2"');
});

test('stringifyRow: null/undefined become empty fields', () => {
  assert.equal(stringifyRow(['a', null, undefined, '']), 'a,,,');
});

test('round-trip: stringifyRow -> parse preserves commas, quotes, newlines', () => {
  const row = ['2026-06-14', 'Acme, Inc.', 'Eng "Lead"', 'note\nwith newline', ''];
  const parsed = parse(stringifyRow(row));
  assert.deepEqual(parsed, [row]);
});

test('round-trip: multi-row tracker-style file', () => {
  const header = ['date', 'company', 'role', 'url', 'status', 'notes'];
  const r1 = ['2026-06-14', 'Acme', 'Engineer, Senior', 'https://a/1', 'SUBMITTED', 'ok'];
  const r2 = ['2026-06-13', 'Beta', 'Analyst', 'https://b/2', 'ready', 'has "quotes", and, commas'];
  const text = [header, r1, r2].map(stringifyRow).join('\n') + '\n';
  assert.deepEqual(parse(text), [header, r1, r2]);
  assert.deepEqual(parseObjects(text), [
    { date: r1[0], company: r1[1], role: r1[2], url: r1[3], status: r1[4], notes: r1[5] },
    { date: r2[0], company: r2[1], role: r2[2], url: r2[3], status: r2[4], notes: r2[5] },
  ]);
});

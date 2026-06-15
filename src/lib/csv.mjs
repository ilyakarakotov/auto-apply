// Tiny dependency-free RFC4180-ish CSV reader/writer for tracker.csv and friends.
// Handles quoted fields with embedded commas, escaped "" quotes, and CRLF/LF/CR line
// endings — so a role or notes value with commas/quotes/newlines round-trips intact.
//
// Usage:
//   import { parse, parseObjects, stringifyRow, appendRow } from './lib/csv.mjs';
//   const rows = parseObjects(fs.readFileSync('tracker.csv', 'utf8')); // [{date, company, ...}]
//   appendRow('tracker.csv', ['2026-06-14', 'Acme', 'Eng, Senior', 'https://x', ...]);
import fs from 'node:fs';

// parse(text) -> array of row-arrays. Each row is an array of string field values.
// A field may span multiple lines if it is quoted. Empty trailing input yields [].
export function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // have we seen any char on the current (possibly empty) row?
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote ""
        else inQuotes = false;                          // closing quote
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; started = true; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++; // CRLF: consume the \n too
      // Only commit the row if it had any content (handles trailing newline cleanly).
      if (started || field.length || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
      continue;
    }
    field += c;
    started = true;
  }
  // flush the final field/row if the text didn't end with a newline
  if (started || field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// parseObjects(text) -> array of objects keyed by the first (header) row. Rows shorter
// than the header get empty strings for missing trailing columns; extra columns are dropped.
export function parseObjects(text) {
  const rows = parse(text);
  if (!rows.length) return [];
  const header = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] ?? '';
    out.push(obj);
  }
  return out;
}

// Quote a single field only when it must be (contains comma, quote, CR or LF), doubling
// any embedded quotes — the minimal-quoting form RFC4180 readers all accept.
function quoteField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// stringifyRow(arr) -> one CSV line (no trailing newline), properly quoted.
export function stringifyRow(arr) {
  return arr.map(quoteField).join(',');
}

// appendRow(filePath, arr) -> append one quoted row plus a newline. Creating the header
// row is out of scope: the file is expected to already exist with a header.
export function appendRow(filePath, arr) {
  fs.appendFileSync(filePath, stringifyRow(arr) + '\n');
}

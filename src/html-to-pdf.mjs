// Convert a resume/cover-letter into a clean Letter-size PDF.
// Accepts an HTML file OR a Markdown file (.md / .markdown) — Markdown is rendered to styled
// HTML first with a small built-in converter (no extra deps), then printed to PDF via Chromium.
// Usage:  node src/html-to-pdf.mjs <input.html|input.md> <output.pdf>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [, , input, output] = process.argv;
if (!input || !output) { console.error('usage: html-to-pdf.mjs <in.(html|md)> <out.pdf>'); process.exit(1); }
if (!fs.existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }

// ---- minimal, dependency-free Markdown -> HTML (enough for a resume) --------------------
function mdInline(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null, para = [];
  const closePara = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; } };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { closePara(); closeList(); continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { closePara(); closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closePara(); closeList(); out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { closePara(); if (listType !== 'ul') { closeList(); listType = 'ul'; out.push('<ul>'); } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { closePara(); if (listType !== 'ol') { closeList(); listType = 'ol'; out.push('<ol>'); } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    closeList(); para.push(line.trim());
  }
  closePara(); closeList();
  return out.join('\n');
}

const RESUME_CSS = `
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt;
         line-height: 1.4; color: #1a1a1a; max-width: 7.2in; margin: 0 auto; }
  h1 { font-size: 19pt; margin: 0 0 2px; }
  h2 { font-size: 12pt; border-bottom: 1px solid #999; padding-bottom: 2px; margin: 14px 0 6px;
       text-transform: uppercase; letter-spacing: .04em; }
  h3 { font-size: 11pt; margin: 10px 0 2px; }
  p { margin: 4px 0; }
  ul, ol { margin: 4px 0 8px; padding-left: 18px; }
  li { margin: 2px 0; }
  a { color: inherit; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 10px 0; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; }
`;

let html;
if (/\.(md|markdown)$/i.test(input)) {
  html = `<!doctype html><html><head><meta charset="utf-8"><style>${RESUME_CSS}</style></head><body>\n${mdToHtml(fs.readFileSync(input, 'utf8'))}\n</body></html>`;
}

const b = await chromium.launch();
const p = await b.newPage();
if (html) {
  await p.setContent(html, { waitUntil: 'networkidle' });
} else {
  await p.goto('file://' + path.resolve(input), { waitUntil: 'networkidle' });
}
await p.pdf({ path: output, format: 'Letter', printBackground: true,
  margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' } });
await b.close();
console.log('wrote', output);

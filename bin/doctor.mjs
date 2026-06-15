#!/usr/bin/env node
// Preflight check: verifies the toolchain + config this pipeline needs before you apply to anything.
// Prints a PASS/FAIL/WARN/INFO checklist (check name, status, one-line fix) and exits non-zero if
// any REQUIRED check fails — so you can wire it into CI or a daily orchestrator as a gate.
// Node builtins only; never installs anything.
//
//   node bin/doctor.mjs        # run all checks, print the checklist
//   npm run doctor
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...a) => path.join(ROOT, ...a);
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

// Run a command quietly; return {ok, out}. Never throws (a missing binary is just ok:false).
function run(cmd, argv, timeout = 8000) {
  try {
    const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) return { ok: false, out: ((r.stdout || '') + (r.stderr || '')).trim() };
    return { ok: true, out: (r.stdout || '').trim() };
  } catch { return { ok: false, out: '' }; }
}

// ---- checklist accumulator ----------------------------------------------------------------
// status: 'PASS' (required, satisfied) | 'FAIL' (required, missing) | 'WARN' (recommended) | 'INFO'
const results = [];
const add = (name, status, fix = '') => results.push({ name, status, fix });

// ---- 1. Node >= 18 (REQUIRED) -------------------------------------------------------------
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 18) add(`Node.js ${process.versions.node}`, 'PASS');
else add(`Node.js ${process.versions.node}`, 'FAIL', 'install Node 18+ (nodejs.org or nvm)');

// ---- 2. python3 (REQUIRED — build-queue.py) ----------------------------------------------
const py = run('python3', ['--version']);
if (py.ok) add(`python3 (${py.out || 'present'})`, 'PASS');
else add('python3', 'FAIL', 'install Python 3 (build-queue.py needs it)');

// ---- 3. a Chrome/Chromium binary (REQUIRED — the real-browser form fill) ------------------
const chromeEnv = process.env.CHROME_PATH || process.env.CHROME_BIN || '';
const chromeCandidates = [
  chromeEnv,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  // Linux
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
].filter(Boolean);
let chromeFound = chromeCandidates.find(exists) || '';
if (!chromeFound) {
  // fall back to a PATH lookup (`which <name>`) for any of the common binary names
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']) {
    const w = run('which', [name]);
    if (w.ok && w.out) { chromeFound = w.out.split('\n')[0]; break; }
  }
}
if (chromeFound) add(`Chrome/Chromium (${chromeFound})`, 'PASS');
else add('Chrome/Chromium', 'FAIL', 'install Google Chrome (mac) or google-chrome-stable/chromium (linux); or set CHROME_PATH');

// ---- 4. playwright-cli available (WARN — the agent's browser "hands") ----------------------
// The whole apply loop drives the real browser via @playwright/cli (the `playwright-cli` binary:
// attach/goto/run-code/eval/snapshot/upload). This is distinct from the `playwright` library used
// only for PDF rendering (check 5). Prefer the project-local install; warn if absent.
let pwCli = run('npx', ['--no-install', 'playwright-cli', '--version']);
if (!pwCli.ok) pwCli = run('playwright-cli', ['--version']); // a global install
if (pwCli.ok) add(`playwright-cli (${pwCli.out.split('\n')[0] || 'present'})`, 'PASS');
else add('playwright-cli', 'WARN', 'run `npm install` (devDep) or `npm i -g @playwright/cli` — the agent drives the browser with it');

// ---- 5. Playwright chromium browser installed (WARN — html-to-pdf rendering) --------------
// `npx playwright install chromium` downloads the bundled browser used by src/html-to-pdf.mjs.
// We check the cache dir rather than launching anything.
const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
  ? process.env.PLAYWRIGHT_BROWSERS_PATH
  : path.join(process.env.HOME || process.env.USERPROFILE || '', {
      darwin: 'Library/Caches/ms-playwright',
      win32: 'AppData\\Local\\ms-playwright',
    }[process.platform] || '.cache/ms-playwright');
let pwChromium = false;
try { pwChromium = exists(pwCache) && fs.readdirSync(pwCache).some((d) => /^chromium/.test(d)); } catch {}
if (pwChromium) add('Playwright chromium (PDF rendering)', 'PASS');
else add('Playwright chromium (PDF rendering)', 'WARN', 'run `npx playwright install chromium`');

// ---- 6. config/profile.yaml (REQUIRED) ----------------------------------------------------
const profilePath = P('config/profile.yaml');
const profileOk = exists(profilePath);
if (profileOk) add('config/profile.yaml', 'PASS');
else add('config/profile.yaml', 'FAIL', 'run `npm run init` to generate it');

// ---- 7. config/rules.json exists AND is newer than profile.yaml (WARN if stale) -----------
const rulesPath = P('config/rules.json');
if (!exists(rulesPath)) {
  add('config/rules.json', profileOk ? 'WARN' : 'INFO', 'run `npm run build-rules`');
} else if (profileOk && mtime(rulesPath) < mtime(profilePath)) {
  add('config/rules.json (stale)', 'WARN', 'profile.yaml is newer — run `npm run build-rules`');
} else {
  add('config/rules.json', 'PASS');
}

// ---- 8. base resume from profile.resume.base (WARN) ---------------------------------------
// Read the path straight out of the YAML without a YAML dep: one shallow `base:` under `resume:`.
let resumeBase = '';
if (profileOk) {
  try {
    const txt = fs.readFileSync(profilePath, 'utf8');
    let inResume = false;
    for (const line of txt.split('\n')) {
      if (/^resume:\s*(#.*)?$/.test(line)) { inResume = true; continue; }
      if (inResume) {
        if (/^\S/.test(line)) break; // dedented out of the resume: block
        const m = line.match(/^\s+base:\s*(.+?)\s*(#.*)?$/);
        if (m) { resumeBase = m[1].replace(/^["']|["']$/g, '').trim(); break; }
      }
    }
  } catch {}
}
if (!profileOk) add('base resume', 'INFO', 'set resume.base in config/profile.yaml after init');
else if (!resumeBase) add('base resume', 'WARN', 'set resume.base in config/profile.yaml');
else if (exists(path.resolve(ROOT, resumeBase))) add(`base resume (${resumeBase})`, 'PASS');
else add(`base resume (${resumeBase})`, 'WARN', 'put your resume at that path, or fix resume.base in config/profile.yaml');

// ---- 9. applications/ dir (WARN) ----------------------------------------------------------
if (exists(P('applications'))) add('applications/ dir', 'PASS');
else add('applications/ dir', 'WARN', 'run `mkdir -p applications` (per-application working dirs land here)');

// ---- 10. config/email-imap.json (INFO — optional) -----------------------------------------
if (exists(P('config/email-imap.json'))) add('config/email-imap.json', 'INFO', 'present — email-gate + followups enabled');
else add('config/email-imap.json', 'INFO', 'optional: add it to enable email-verification gates + followups');

// ---- 11. duckdb importable via python3 (INFO — optional jobhive dataset) ------------------
if (py.ok) {
  const duck = run('python3', ['-c', 'import duckdb']);
  if (duck.ok) add('python duckdb module', 'INFO', 'present — jobhive dataset enabled');
  else add('python duckdb module', 'INFO', 'optional: `pip install duckdb` to query the jobhive dataset');
} else {
  add('python duckdb module', 'INFO', 'optional (needs python3): `pip install duckdb` for the jobhive dataset');
}

// ---- render --------------------------------------------------------------------------------
const MARK = { PASS: ' OK ', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO' };
const nameWidth = Math.max(...results.map((r) => r.name.length));
console.log('\nauto-apply doctor\n');
for (const r of results) {
  const line = `  [${MARK[r.status]}]  ${r.name.padEnd(nameWidth)}`;
  console.log(r.status === 'PASS' ? line : `${line}  -> ${r.fix}`);
}

const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${fails ? `${fails} required check(s) failed. ` : 'all required checks passed. '}` +
  `${warns ? `${warns} warning(s).` : ''}`.trim());
process.exit(fails ? 1 : 0);

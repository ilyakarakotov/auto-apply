#!/usr/bin/env node
// ============================================================================
//  Auto-Apply Engine — init wizard
// ============================================================================
// Interactive setup. Asks a short set of questions, then writes a complete, ready-to-edit
// project state:
//   config/profile.yaml   seeded from your answers (review & complete the rest by hand)
//   config/rules.json     generated from the profile (via src/build-rules.mjs)
//   config/qa-bank.json   empty (the engine learns exact-text answers into it at runtime)
//   config/queue.yaml     empty (populated by discovery)
//   config/companies.json starter set (a data file — grow it freely)
//   tracker.csv           header row
//   CLAUDE.md             the operating manual, tailored to your profile
//
//   node bin/init.mjs            # interactive
//   node bin/init.mjs --yes      # non-interactive: accept all example defaults
//   node bin/init.mjs --force    # overwrite an existing config/profile.yaml
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...a) => path.join(ROOT, ...a);
const args = process.argv.slice(2);
const YES = args.includes('--yes') || args.includes('-y');
const FORCE = args.includes('--force');
const exists = (p) => fs.existsSync(p);

const examplePath = P('config/profile.example.yaml');
if (!exists(examplePath)) { console.error('config/profile.example.yaml missing — run from the project root.'); process.exit(1); }
// Require explicit --force to overwrite an existing profile, even with --yes — otherwise a
// non-interactive/CI `init --yes` would silently wipe a completed profile back to example defaults.
if (exists(P('config/profile.yaml')) && !FORCE) {
  console.error('config/profile.yaml already exists. Re-run with --force to overwrite, or edit it directly.');
  process.exit(1);
}

const doc = YAML.parseDocument(fs.readFileSync(examplePath, 'utf8')); // keeps the example's comments
const interactive = !YES && stdin.isTTY;
const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;

async function ask(question, dflt = '') {
  if (!interactive) return dflt;
  try {
    const a = (await rl.question(`${question}${dflt ? ` [${dflt}]` : ''}: `)).trim();
    return a || dflt;
  } catch { return dflt; } // stdin closed (EOF / piped input ran out) -> take the default
}
async function askBool(question, dflt = false) {
  const a = (await ask(`${question} (y/n)`, dflt ? 'y' : 'n')).toLowerCase();
  return /^y/.test(a);
}
const splitList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);
const set = (pathArr, val) => { if (val !== undefined && val !== null && val !== '') doc.setIn(pathArr, val); };
const setList = (pathArr, arr) => { if (arr && arr.length) doc.setIn(pathArr, arr); };

if (interactive) {
  console.log('\n  Auto-Apply Engine setup. Press Enter to accept the [default] shown.');
  console.log('  This collects the essentials; you\'ll finish the rest in config/profile.yaml.\n');
}

// ---- questions (the essentials; the example fills in sensible defaults for the rest) ----
const ex = doc.toJSON();
const first = await ask('Your first name', ex.identity.first_name);
const lastDefault = ex.identity.last_name;
const last = await ask('Your last name', lastDefault);
const fullName = await ask('Full legal name (as on applications)', `${first} ${last}`);
const email = await ask('Email you apply with (receives ATS verification codes)', ex.identity.email);
const phone = await ask('Phone number', ex.identity.phone);
const city = await ask('City you live in', ex.identity.city);
const state = await ask('State (full name, e.g. Texas)', ex.identity.state);
const stateAbbr = await ask('State abbreviation (e.g. TX)', ex.identity.state_abbr);
const linkedin = await ask('LinkedIn URL (optional)', ex.identity.linkedin);
const resumeBase = await ask('Path to your base resume (markdown or html)', ex.resume.base);
const roles = interactive
  ? splitList(await ask('Target role keywords (comma-separated)', (ex.search.target_roles || []).join(', ')))
  : ex.search.target_roles;
const locations = interactive
  ? splitList(await ask('Target locations (comma-separated; e.g. Austin, Texas, Remote US)', (ex.search.target_locations || []).join(', ')))
  : ex.search.target_locations;
const needsSponsorship = await askBool('Do you need visa sponsorship (now or in the future)?', ex.work_authorization.needs_sponsorship);
let citizenship = ex.work_authorization.citizenship, visaType = ex.work_authorization.visa_type || '';
let isCitizenOrPR = ex.work_authorization.is_us_citizen_or_pr;
if (needsSponsorship) {
  citizenship = await ask('Country of citizenship', citizenship === 'United States' ? '' : citizenship);
  visaType = await ask('Visa type (e.g. H-1B Transfer)', visaType || 'H-1B Transfer');
  isCitizenOrPR = false;
} else {
  citizenship = await ask('Country of citizenship', citizenship);
}
const years = await ask('Total years of relevant experience', String(ex.experience.years_total));
const eduLevel = await ask('Highest education level (High School|Associate\'s|Bachelor\'s|Master\'s|Doctorate)', ex.education.highest_level);
if (rl) rl.close();

// ---- write config/profile.yaml (seeded answers + example defaults for everything else) ----
set(['identity', 'first_name'], first);
set(['identity', 'last_name'], last);
set(['identity', 'full_name'], fullName);
set(['identity', 'preferred_name'], first);
set(['identity', 'email'], email);
set(['identity', 'phone'], phone);
set(['identity', 'city'], city);
set(['identity', 'state'], state);
set(['identity', 'state_abbr'], stateAbbr);
set(['identity', 'linkedin'], linkedin);
set(['resume', 'base'], resumeBase);
setList(['search', 'target_roles'], roles);
setList(['search', 'target_locations'], locations);
set(['work_authorization', 'citizenship'], citizenship);
doc.setIn(['work_authorization', 'needs_sponsorship'], needsSponsorship);
doc.setIn(['work_authorization', 'is_us_citizen_or_pr'], isCitizenOrPR);
set(['work_authorization', 'visa_type'], visaType);
set(['experience', 'years_total'], String(years));
set(['education', 'highest_level'], eduLevel);

fs.writeFileSync(P('config/profile.yaml'), doc.toString());
console.log('  wrote config/profile.yaml');

// ---- generate rules.json from the new profile ----
try {
  execFileSync('node', [P('src/build-rules.mjs')], { stdio: 'inherit', cwd: ROOT });
} catch (e) {
  console.error('  build-rules failed — run `npm run build-rules` after fixing config/profile.yaml.');
}

// ---- empty learned-answer bank + empty queue ----
if (!exists(P('config/qa-bank.json')) || FORCE) {
  fs.writeFileSync(P('config/qa-bank.json'), JSON.stringify({
    _readme: 'Exact-text Q->A answers the engine learns at runtime. Each: {q, value|option, src}. Starts empty.',
    answers: []
  }, null, 1));
  console.log('  wrote config/qa-bank.json (empty)');
}
if (!exists(P('config/queue.yaml')) || FORCE) {
  fs.writeFileSync(P('config/queue.yaml'),
    '# Application queue — populated by `bash scripts/discover-daily.sh`. Empty to start.\n');
  console.log('  wrote config/queue.yaml (empty)');
}

// ---- starter companies.json (a data file; grow it freely) ----
if (!exists(P('config/companies.json'))) {
  if (exists(P('config/companies.example.json'))) fs.copyFileSync(P('config/companies.example.json'), P('config/companies.json'));
  else fs.writeFileSync(P('config/companies.json'), JSON.stringify({ greenhouse: [], lever: [], ashby: [], smartrecruiters: [], workable: [] }, null, 1));
  console.log('  wrote config/companies.json (starter — add the companies you want to sweep)');
}

// ---- starter resume + applications/ scaffolding (so the first apply never fails on a missing file) ----
fs.mkdirSync(P('applications/_resumes'), { recursive: true });
if (!exists(P('applications/_resumes/resume-base.md')) && exists(P('config/resume-base.example.md'))) {
  fs.copyFileSync(P('config/resume-base.example.md'), P('applications/_resumes/resume-base.md'));
  console.log('  wrote applications/_resumes/resume-base.md (starter resume — replace with your own)');
}

// ---- login-walled / manual-only list (jobs the engine must NEVER auto-submit; optional) ----
if (!exists(P('config/manual-apply.yaml')) && exists(P('config/manual-apply.example.yaml'))) {
  fs.copyFileSync(P('config/manual-apply.example.yaml'), P('config/manual-apply.yaml'));
  console.log('  wrote config/manual-apply.yaml (from example)');
}

// ---- tracker.csv header ----
if (!exists(P('tracker.csv'))) {
  fs.writeFileSync(P('tracker.csv'), 'date,company,role,url,ats,resume_file,status,screenshot,notes,followup_status\n');
  console.log('  wrote tracker.csv (header)');
}

// ---- tailored CLAUDE.md from the template ----
if (exists(P('CLAUDE.template.md'))) {
  const pr = doc.toJSON();
  const human = (a) => (a || []).join(', ');
  const locSummary = [...(pr.search.target_locations || [])].join(', ');
  const sponsorshipRule = pr.work_authorization.needs_sponsorship
    ? `You DO need visa sponsorship${pr.work_authorization.visa_type ? ` (${pr.work_authorization.visa_type})` : ''}. ` +
      `Answer "authorized to work WITHOUT sponsorship?" truthfully **No** — plan-apply flags these as a gate and ` +
      `skips with SKIPPED-NO-SPONSORSHIP. Always answer sponsorship questions truthfully; never answer No just to clear a filter.`
    : `You do NOT need visa sponsorship — you are authorized to work without it. Answer work-authorization questions ` +
      `Yes and "do you require sponsorship?" No, truthfully.`;
  const claude = fs.readFileSync(P('CLAUDE.template.md'), 'utf8')
    .replaceAll('{{full_name}}', pr.identity.full_name || fullName)
    .replaceAll('{{role_summary}}', `targeting ${human(pr.search.target_roles)}`)
    .replaceAll('{{location_summary}}', locSummary || 'see config/profile.yaml')
    .replaceAll('{{sponsorship_rule}}', sponsorshipRule)
    .replaceAll('{{target_roles}}', human(pr.search.target_roles))
    .replaceAll('{{exclude_titles}}', human(pr.search.exclude_titles_containing))
    .replaceAll('{{resume_base}}', pr.resume.base);
  fs.writeFileSync(P('CLAUDE.md'), claude);
  console.log('  wrote CLAUDE.md (tailored)');
}

console.log('\n  Done. Next steps:');
console.log('   1. Open config/profile.yaml and complete it honestly (address, skills, demographics, essays).');
console.log('   2. Replace applications/_resumes/resume-base.md with your real resume (Markdown or HTML).');
console.log('   3. Re-run `npm run build-rules` after any profile edit.');
console.log('   4. Run `npm run doctor` to verify your toolchain + config.');
console.log('   5. Start a browser (`npm run browser`), then `npm run discover-daily` to fill the queue.');
console.log('   6. Open Claude Code in this directory and run /apply (or run scripts/daily-orchestrate.sh).\n');

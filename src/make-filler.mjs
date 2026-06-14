#!/usr/bin/env node
// Builds the one-shot form filler from config/rules.json (+ optional per-job plan).
// Usage:
//   node src/make-filler.mjs --resume applications/_resumes/resume.pdf \
//        [--plan /tmp/plan-<id>.json] [--out /tmp/fill-run.js]
// Then: playwright-cli run-code --filename /tmp/fill-run.js
// ONE source of truth: config/rules.json is GENERATED from config/profile.yaml by
// src/build-rules.mjs — edit the profile and re-run build-rules, never the generated file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };

const resume = get('--resume', path.join(ROOT, 'applications/_resumes/resume.pdf'));
const planPath = get('--plan', null);
const outPath = get('--out', '/tmp/fill-run.js');

const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/rules.json'), 'utf8'));

// qa-bank: exact-text Q->A learned at runtime; merged into the plan layer (highest priority after per-job plan)
let bank = [];
try {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/qa-bank.json'), 'utf8'));
  bank = b.answers || [];
} catch {}

let plan = [];
if (planPath) {
  try {
    const p = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan = (p.fields || []).filter(f => f.option || f.value).map(f => ({ q: f.q, option: f.option, value: f.value }));
  } catch (e) { console.error(`WARN: could not read plan ${planPath}: ${e.message}`); }
}

const cfg = {
  resume: path.isAbsolute(resume) ? resume : path.join(ROOT, resume),
  identity: rules.identity,
  text_fields: rules.text_fields,
  dropdown_rules: rules.dropdown_rules,
  essays: rules.essays,
  essay_rules: rules.essay_rules,
  consent_checkbox: rules.consent_checkbox,
  plan: [...bank, ...plan] // per-job plan entries last so they win (template: later exact match overwrites)
};

if (!fs.existsSync(cfg.resume)) console.error(`WARN: resume not found at ${cfg.resume}`);

const template = fs.readFileSync(path.join(ROOT, 'src/filler.template.js'), 'utf8');
const body = template
  .replace(/^(\/\/[^\n]*\n)+/, '') // strip the leading template header comment lines
  .replace('"__CFG__"', () => JSON.stringify(cfg)); // fn form: avoid $&/$'/$` being treated as special replacement patterns when a rule note contains e.g. "$'"

fs.writeFileSync(outPath, body);
console.log(`wrote ${outPath} (resume=${path.basename(cfg.resume)}, plan entries=${cfg.plan.length})`);

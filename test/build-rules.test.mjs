// Integration test for src/build-rules.mjs: it must expand a profile.yaml into a
// valid rules.json. We write a temp profile (a trimmed, person-agnostic variant of
// config/profile.example.yaml) to os.tmpdir(), invoke the script via child_process,
// parse the emitted JSON, and assert the shape plus the sponsorship-gate behaviour.
// Everything is hermetic: temp files only, cleaned up after each run.
//
//   node --test test/build-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'src/build-rules.mjs');

// A minimal valid profile. needs_sponsorship is parameterised so we can assert the
// sponsorship gate appears only when sponsorship is required. Values are generic.
function profileYaml({ needsSponsorship }) {
  return `identity:
  first_name: Sam
  last_name: Rivera
  full_name: Sam Rivera
  email: sam.rivera@example.com
  phone: 555-000-1111
  city: Metropolis
  state: Example State
  state_abbr: EX
  zip: "00001"
  country: United States
  pronouns: They/Them
current:
  company: Globex
  title: Analyst
logistics:
  salary_text: "Open / flexible"
  notice_text: "Available immediately"
  open_to_relocation: true
  open_to_remote: true
  open_to_onsite: true
  needs_relocation_assistance: false
work_authorization:
  citizenship: United States
  authorized_to_work_us: true
  is_us_citizen_or_pr: ${needsSponsorship ? 'false' : 'true'}
  currently_in_us: true
  needs_sponsorship: ${needsSponsorship ? 'true' : 'false'}
  visa_type: "${needsSponsorship ? 'H-1B Transfer' : ''}"
  skip_no_sponsorship_roles: true
education:
  highest_level: Bachelor's
  degree: BA Generic Studies
  school: Example University
  graduation_year: "2016"
experience:
  years_total: "8"
  skills_expert: [Modeling, Forecasting]
  skills_proficient: [Power BI]
  skills_working: [SQL, Python]
  certifications: []
  has_cpa: false
  has_cfa: false
  has_management_experience: false
demographics:
  gender: ""
  transgender: false
  race: ""
  hispanic_latino: false
  veteran_status: ""
  disability: ""
  english_fluency: Native
essays:
  why: >-
    I would welcome the chance to discuss how my experience fits this role.
  general: >-
    I turn analysis into clear recommendations leaders can act on.
essay_keywords:
  why: ["why (do|are|would) you"]
  general: ["tell us about", "describe (a|your)"]
`;
}

// Run build-rules against a temp profile and return the parsed rules JSON.
function buildRules(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-rules-'));
  const profilePath = path.join(dir, 'profile.yaml');
  const outPath = path.join(dir, 'rules.json');
  fs.writeFileSync(profilePath, profileYaml(opts));
  try {
    execFileSync('node', [SCRIPT, '--profile', profilePath, '--out', outPath], {
      stdio: 'pipe',
    });
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('build-rules emits valid JSON with all top-level sections', () => {
  const rules = buildRules({ needsSponsorship: false });
  assert.equal(typeof rules, 'object');
  for (const key of ['identity', 'text_fields', 'dropdown_rules', 'gates', 'essays']) {
    assert.ok(key in rules, `missing section: ${key}`);
  }
  assert.ok(Array.isArray(rules.text_fields));
  assert.ok(Array.isArray(rules.dropdown_rules));
  assert.ok(Array.isArray(rules.gates));
});

test('identity.full_name reflects the profile', () => {
  const rules = buildRules({ needsSponsorship: false });
  assert.equal(rules.identity.full_name, 'Sam Rivera');
  assert.equal(rules.identity.email, 'sam.rivera@example.com');
});

test('sponsorship skip gate is present when needs_sponsorship is true', () => {
  const rules = buildRules({ needsSponsorship: true });
  const skipGates = rules.gates.filter((g) => g.action === 'skip');
  assert.ok(skipGates.length > 0, 'expected at least one action:"skip" gate');
});

test('sponsorship skip gate is absent when needs_sponsorship is false', () => {
  const rules = buildRules({ needsSponsorship: false });
  const skipGates = rules.gates.filter((g) => g.action === 'skip');
  assert.equal(skipGates.length, 0, 'no skip gate should exist without sponsorship');
  // The universal email-verification gate must still be present regardless.
  assert.ok(rules.gates.some((g) => g.action === 'email-verify'));
});

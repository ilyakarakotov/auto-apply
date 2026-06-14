#!/usr/bin/env node
// PRE-FLIGHT PLANNER. Fetches a job's REAL application form definition straight from the
// ATS API (no browser, no snapshot), resolves every question against config/rules.json +
// config/qa-bank.json, and writes a per-job plan with EXACT option labels.
//
//   node src/plan-apply.mjs --ats greenhouse --company acme --id 4192987009
//   node src/plan-apply.mjs --url https://jobs.ashbyhq.com/acme/8006e7a0-...
//   node src/plan-apply.mjs --url https://jobs.lever.co/acme/3bca1d20-...
//
// Prints a SHORT summary (the only part the agent should read) and writes /tmp/plan-<key>.json.
// Then: node src/make-filler.mjs --resume <pdf> --plan /tmp/plan-<key>.json
// Exit codes: 0 ok, 2 = sponsorship/exp gate -> recommend SKIP, 3 = form def unavailable (probe in browser).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
let url = get('--url', ''), ats = get('--ats', ''), company = get('--company', ''), id = get('--id', '');

if (url && !ats) {
  if (/greenhouse\.io/.test(url)) ats = 'greenhouse';
  else if (/lever\.co/.test(url)) ats = 'lever';
  else if (/ashbyhq\.com/.test(url)) ats = 'ashby';
  else if (/smartrecruiters\.com/.test(url)) ats = 'smartrecruiters';
  else if (/workable\.com/.test(url)) ats = 'workable';
}
if (url && (!company || !id)) {
  let m;
  if ((m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)(?:\/jobs\/|&token=)(\d+)/))) { company ||= m[1]; id ||= m[2]; }
  else if ((m = url.match(/lever\.co\/([\w-]+)\/([0-9a-f-]{36})/))) { company ||= m[1]; id ||= m[2]; }
  else if ((m = url.match(/ashbyhq\.com\/([\w%.-]+)\/([0-9a-f-]{36})/))) { company ||= decodeURIComponent(m[1]); id ||= m[2]; }
  else if ((m = url.match(/smartrecruiters\.com\/([\w-]+)\/(\d+)/))) { company ||= m[1]; id ||= m[2]; }
}

const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/rules.json'), 'utf8'));
let bank = { answers: [] };
try { bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/qa-bank.json'), 'utf8')); } catch {}
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[*✱]+\s*$/, '').trim();
const bankMap = new Map((bank.answers || []).map(a => [norm(a.q), a]));
const DR = rules.dropdown_rules.map(r => ({ ...r, re: new RegExp(r.q, 'i'), optRes: r.opts.map(o => new RegExp(o, 'i')) }));
const TF = rules.text_fields.map(r => ({ ...r, re: new RegExp(r.match, 'i') }));
const ER = rules.essay_rules.map(r => ({ ...r, re: new RegExp(r.q, 'i') }));
const GATES = (rules.gates || []).map(g => ({ ...g, re: new RegExp(g.q, 'i') }));
const resolveVal = (v) => (typeof v === 'string' && v[0] === '@') ? (rules.identity[v.slice(1)] ?? v) : v;

async function fetchJson(u, opts = {}, ms = 12000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(u, { ...opts, signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0', ...(opts.headers || {}) } });
    clearTimeout(t);
    if (!r.ok) return null;
    return opts.text ? await r.text() : await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// ---- per-ATS form definition fetchers -> [{q, required, type, options[]}] ----
async function ghForm() {
  const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${id}?questions=true`);
  if (!j || !j.questions) return null;
  const qs = [];
  const mapQ = (q) => qs.push({
    q: q.label, required: !!q.required,
    type: (q.fields && q.fields[0] && q.fields[0].type) || q.type || 'input_text',
    options: ((q.fields && q.fields[0] && q.fields[0].values) || q.answer_options || []).map(v => v.label)
  });
  for (const q of j.questions) mapQ(q);
  for (const q of ((j.demographic_questions || {}).questions || [])) mapQ(q);
  for (const c of (j.compliance || [])) for (const q of (c.questions || [])) mapQ(q);
  return { title: j.title, qs };
}

async function ashbyForm() {
  const body = {
    operationName: 'ApiJobPosting',
    variables: { organizationHostedJobsPageName: company, jobPostingId: id },
    query: 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title applicationForm { sections { title fieldEntries { field isRequired } } } } }'
  };
  const j = await fetchJson('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const form = j && j.data && j.data.jobPosting && j.data.jobPosting.applicationForm;
  if (!form) return null;
  const qs = [];
  for (const s of form.sections || []) for (const fe of s.fieldEntries || []) {
    const f = fe.field || {};
    qs.push({ q: f.title || '', required: !!fe.isRequired, type: f.type || 'String', options: (f.selectableValues || []).map(v => v.label) });
  }
  return { title: j.data.jobPosting.title, qs };
}

async function leverForm() {
  const html = await fetchJson(`https://jobs.lever.co/${company}/${id}/apply`, { text: true });
  if (!html || typeof html !== 'string') return null;
  const qs = [];
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  // custom question cards + standard EEO blocks both render as application-question <li>s
  const blocks = html.split(/class="application-question/).slice(1);
  for (const b of blocks) {
    const chunk = b.slice(0, 4000);
    const lm = chunk.match(/application-label[^>]*>([\s\S]*?)<\/(div|label)>/);
    const q = lm ? strip(lm[1]) : '';
    if (!q) continue;
    const required = /✱|required/i.test(chunk.slice(0, 600));
    let type = 'input_text', options = [];
    if (/<select/i.test(chunk)) { type = 'select'; options = [...chunk.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map(m => strip(m[1])).filter(o => o && !/^select|^choose|^-+$/i.test(o)); }
    else if (/<textarea/i.test(chunk)) type = 'textarea';
    else if (/type="checkbox"/i.test(chunk)) { type = 'checkbox_group'; options = [...chunk.matchAll(/type="checkbox"[^>]*value="([^"]*)"/g)].map(m => strip(m[1])); }
    else if (/type="radio"/i.test(chunk)) { type = 'radio_group'; options = [...chunk.matchAll(/type="radio"[^>]*value="([^"]*)"/g)].map(m => strip(m[1])); }
    else if (/type="file"/i.test(chunk)) type = 'file';
    qs.push({ q, required, type, options });
  }
  const tm = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  return qs.length >= 2 ? { title: tm ? strip(tm[1]) : '', qs } : null;
}

async function srForm() {
  const j = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`);
  if (!j) return null;
  const qs = [];
  for (const q of ((j.applyQuestions || j.questions) || [])) qs.push({ q: q.label || q.text || '', required: !!q.required, type: q.type || 'input_text', options: (q.options || q.values || []).map(o => o.label || o.value || String(o)) });
  return { title: j.name, qs };
}

// ---- resolve one question against bank -> gates -> rules ----
function resolveQ(item) {
  const qc = item.q.replace(/[✱*]+/g, ' ').replace(/\s+/g, ' ').trim(); // Lever appends a required-marker ✱
  const isSelect = /select|ValueSelect|Boolean|radio|checkbox/i.test(item.type) || (item.options && item.options.length);
  const isFile = /file/i.test(item.type);
  const isEssay = /textarea|LongText/i.test(item.type) || (!isSelect && !isFile && qc.length >= 60);
  if (/^location$/i.test(qc)) return { ...item, kind: 'location', via: 'widget-pass' }; // autocomplete widget; filler pass 4 owns it
  const hit = bankMap.get(norm(qc));
  if (hit) return { ...item, kind: isSelect ? 'select' : (isEssay ? 'essay' : 'text'), ...(hit.option ? { option: hit.option } : { value: hit.value }), via: 'bank' };
  if (isFile) return { ...item, kind: 'file', via: 'resume-upload' };
  if (isSelect) {
    const r = DR.find(r => r.re.test(qc));
    if (r) {
      for (const optRe of r.optRes) {
        const exact = (item.options || []).find(o => optRe.test(o));
        if (exact) return { ...item, kind: 'select', option: exact, via: 'rule' };
      }
      return { ...item, kind: 'select', via: 'rule-no-truthful-option' }; // leave blank
    }
    // Boolean with no options -> Yes/No widget
    if (/Boolean/i.test(item.type)) {
      const r2 = DR.find(r => r.re.test(qc));
      if (r2) { const yes = r2.optRes.some(re => re.test('Yes')); return { ...item, kind: 'select', option: yes ? 'Yes' : 'No', via: 'rule' }; }
    }
    return null;
  }
  if (isEssay) {
    const er = ER.find(r => r.re.test(qc));
    if (er) return { ...item, kind: 'essay', value: rules.essays[er.essay], via: 'essay-bank' };
    return null;
  }
  const tf = TF.find(r => r.re.test(qc));
  if (tf) return { ...item, kind: 'text', value: resolveVal(tf.value), via: 'rule' };
  return null;
}

// ---- main ----
const fetchers = { greenhouse: ghForm, ashby: ashbyForm, lever: leverForm, smartrecruiters: srForm };
const fn = fetchers[ats];
if (!fn || !company || !id) {
  console.log(JSON.stringify({ mode: 'browser-probe', reason: `unsupported or missing ats/company/id (ats=${ats})` }));
  process.exit(3);
}
const form = await fn();
if (!form) {
  console.log(JSON.stringify({ mode: 'browser-probe', reason: 'form definition not fetchable; fall back to in-browser probe' }));
  process.exit(3);
}

const fields = [], unknowns = [], gateHits = [];
for (const item of form.qs) {
  if (!item.q) continue;
  const qclean = item.q.replace(/[✱*]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const g of GATES) if (g.re.test(qclean) && (!g.required_only || item.required)) gateHits.push({ q: item.q.slice(0, 110), action: g.action, reason: g.reason.split(' - ')[0] });
  const res = resolveQ(item);
  if (res && (res.option || res.value || res.via === 'resume-upload' || res.via === 'rule-no-truthful-option' || res.via === 'widget-pass')) fields.push(res);
  else unknowns.push({ q: item.q.slice(0, 160), required: item.required, type: item.type, options: (item.options || []).slice(0, 14) });
}

const key = `${company}-${id}`.replace(/[^\w-]/g, '').slice(0, 60);
const planPath = `/tmp/plan-${key}.json`;
const plan = { job: { company, id, url, ats, title: form.title }, fields, unknowns, gates: gateHits };
fs.writeFileSync(planPath, JSON.stringify(plan, null, 1));

// SHORT summary - this is all the agent needs to read
const lines = [];
lines.push(`PLAN ${planPath} | ${form.title || ''} | ${form.qs.length} questions: ${fields.length} resolved, ${unknowns.length} unknown`);
for (const g of gateHits) lines.push(`GATE[${g.action.toUpperCase()}]: ${g.q}`);
for (const u of unknowns) lines.push(`? ${u.required ? '(REQUIRED) ' : ''}${u.q}${u.options.length ? ' :: ' + u.options.join(' | ') : ''}`);
if (unknowns.length) lines.push(`-> Answer unknowns truthfully from config/profile.yaml, add {q,option|value} to ${planPath} fields[] (and config/qa-bank.json if reusable), then make-filler --plan.`);
console.log(lines.join('\n'));
process.exit(gateHits.some(g => g.action === 'skip') ? 2 : 0);

#!/usr/bin/env node
// ============================================================================
//  build-rules.mjs — expand config/profile.yaml into config/rules.json
// ============================================================================
// rules.json is the SINGLE SOURCE OF TRUTH every auto-fill decision reads:
// src/plan-apply.mjs resolves an ATS question list against it before the
// browser opens, and src/make-filler.mjs bakes it into the form filler.
//
// The QUESTIONS an ATS asks are universal ("are you authorized to work?",
// "gender", "veteran status", "how many years of experience?") — those
// matching regexes are engine knowledge, hardcoded below. The ANSWERS are
// yours — they all come from profile.yaml. This script joins the two.
//
//   node src/build-rules.mjs                 # config/profile.yaml -> config/rules.json
//   node src/build-rules.mjs --profile x.yaml --out y.json
//
// Re-run it whenever you edit profile.yaml. It NEVER fabricates: a field you
// leave blank produces a "decline" answer or no rule at all, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const profilePath = path.resolve(get('--profile', path.join(ROOT, 'config/profile.yaml')));
const outPath = path.resolve(get('--out', path.join(ROOT, 'config/rules.json')));

if (!fs.existsSync(profilePath)) {
  console.error(`profile not found: ${profilePath}\n` +
    `Create config/profile.yaml (copy config/profile.example.yaml or run \`npm run init\`).`);
  process.exit(1);
}

const P = YAML.parse(fs.readFileSync(profilePath, 'utf8')) || {};
const id = P.identity || {};
const cur = P.current || {};
const log = P.logistics || {};
const wa = P.work_authorization || {};
const edu = P.education || {};
const exp = P.experience || {};
const demo = P.demographics || {};
const essaysIn = P.essays || {};
const kw = P.essay_keywords || {};

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // literal -> regex
const yesNo = (b) => (b ? ['^Yes'] : ['^No']);

// ---------------------------------------------------------------------------
// identity block — the @-referenced values the filler types verbatim
// ---------------------------------------------------------------------------
const first = id.first_name || '';
const last = id.last_name || '';
const stateAbbr = id.state_abbr || id.state || '';
const cityState = [id.city, stateAbbr].filter(Boolean).join(', ');
const identity = {
  first_name: first,
  last_name: last,
  full_name: id.full_name || `${first} ${last}`.trim(),
  preferred_name: id.preferred_name || first,
  email: id.email || '',
  phone: id.phone || '',
  phone_country_option: id.phone_country || 'United States',
  location_city: id.city || '',
  location_full: cityState,
  street_address: [id.street_address_line1, id.street_address_line2].filter(Boolean).join(' '),
  street_address_line1: id.street_address_line1 || '',
  street_address_line2: id.street_address_line2 || '',
  zip: id.zip || '',
  state: id.state || '',
  state_abbr: stateAbbr,
  country: id.country || 'United States',
  citizenship: wa.citizenship || '',
  linkedin: id.linkedin || '',
  current_company: cur.company || '',
  current_title: cur.title || '',
  pronouns: id.pronouns || '',
  salary_text: log.salary_text || 'Open / flexible',
  notice_text: log.notice_text || 'Available immediately',
  years_experience: String(exp.years_total ?? ''),
  school: edu.school || '',
  degree: edu.degree || '',
};

// ---------------------------------------------------------------------------
// gates — questions that should SKIP the whole job (plan-apply exits 2)
// ---------------------------------------------------------------------------
const gates = [];
if (wa.needs_sponsorship && wa.skip_no_sponsorship_roles !== false) {
  gates.push({
    q: "(authoriz(ed|ation)?|eligible|able).{0,80}without (the need for |need of |requiring )?(current or future |employer |visa |employer support or )*sponsor|without sponsorship now or in the future|not require.{0,20}sponsorship (now or )?in the future|without (the need for |needing |requiring )?(visa |employer )?sponsorship",
    required_only: true,
    action: 'skip',
    truthful_answer_if_forced: 'No',
    reason: "Sponsorship gate: 'authorized WITHOUT sponsorship' is truthfully No (you need sponsorship). A required Yes/No version predicts auto-reject; skip and log SKIPPED-NO-SPONSORSHIP."
  });
  gates.push({
    q: "(role|position|job).{0,30}(is )?not eligible for (visa )?sponsor|not eligible for (visa )?sponsorship|does not (offer|provide|sponsor).{0,20}sponsor|acknowledge.{0,40}not eligible for.{0,20}sponsor|unable to (offer|provide).{0,20}sponsor",
    required_only: false,
    action: 'skip',
    truthful_answer_if_forced: 'cannot proceed',
    reason: "No-sponsorship gate: the role explicitly does not sponsor visas. Applying is futile; skip and log SKIPPED-NO-SPONSORSHIP."
  });
}
// Email-verification gate is universal (appears post-submit) — always present.
gates.push({
  q: "verification code|enter the \\d+.character code|code (was )?sent to (your )?email",
  action: 'email-verify',
  reason: "Email-verification gate (e.g. Greenhouse 8-char code; appears POST-submit). NOT a skip: probe reports gates:['email-verification'], then run check-email-code.mjs <company> --wait --code-only, fill the code, submit, confirm. SKIPPED-EMAIL-GATE only if no code arrives within 60s."
});

// ---------------------------------------------------------------------------
// text_fields — single-line inputs. @x => identity.x ; plain string => literal
// ---------------------------------------------------------------------------
const text_fields = [
  { match: 'First Name', value: '@first_name' },
  { match: 'Last Name', value: '@last_name' },
  { match: '^Full (Legal )?Name|Legal Name|^Name$', value: '@full_name' },
  { match: 'Preferred (First )?Name|Preferred Full Name', value: '@preferred_name' },
  { match: '^Email', value: '@email' },
  { match: 'confirm your email', value: '@email' },
  { match: 'Linked ?In', value: '@linkedin' },
  { match: '^(current )?location$|where are you (currently )?located', value: '@location_full' },
  { match: '^Phone$|Phone Number', value: '@phone' },
  { match: 'How did you hear', value: 'LinkedIn' },
  { match: 'salary|compensation|desired pay|pay expectation|expected (base|salary)', value: '@salary_text' },
  { match: 'city, state,? and zip|provide your city, state|city.*state.*zip', value: `${cityState} ${id.zip || ''}`.trim() },
  { match: 'city and state|city.*reside|city of residence|what city', value: cityState },
  { match: 'city$|^city', value: '@location_city' },
  { match: 'address.*zip|legal address.*zip', value: '@zip' },
  { match: 'address.*(city)|legal address.*city', value: '@location_city' },
  { match: 'address.*(state)|legal address.*state', value: '@state' },
  { match: 'address line ?2|street address ?2|address.*line ?2|apt|apartment|unit|suite', value: '@street_address_line2' },
  { match: 'address line ?1|street address ?1|street address|^street$|mailing address|home address|current address|legal address|^address$', value: '@street_address_line1' },
  { match: 'state of residence|^state$|state.*reside', value: '@state' },
  { match: 'zip|postal code', value: '@zip' },
  { match: 'most recent degree|degree you obtained|highest degree', value: '@degree' },
  { match: 'most recent school|school you attended|school name|name of.*school|university', value: '@school' },
  { match: 'notice period|how much notice|notice.*provide|when can you start|start date|availability|earliest you could start|earliest start', value: '@notice_text' },
  { match: 'years of experience|how many years', value: '@years_experience' },
  { match: 'current company|present employer|current employer|current or most recent employer|most recent employer|most recent company|who is your current', value: '@current_company' },
  { match: 'current position|current title|current job title|current role|current or more recent job title|most recent (job )?title|what is your current', value: '@current_title' },
  { match: 'current location \\(country\\)|location \\(country\\)|country you.*(based|located)', value: '@country' },
  { match: 'preferred pronouns|^pronouns|personal pronouns|your pronouns|what.*pronouns', value: '@pronouns' },
  { match: 'permanent work location|work location|where will you (be working|work from)', value: cityState },
  { match: 'do you know anyone|anyone who works|employee referral name', value: 'No' },
  { match: 'name of .* employee who referred|who referred you|referrer.{0,10}name|name of (the )?(person|employee) who referred|if .*referred.*who', value: 'N/A' },
  { match: 'relatives or friends.*work (for|at)|(relatives|friends|family).*work (for|at) (the )?(company|us)|do you have any (relatives|friends)', value: 'N/A' },
];

// ---------------------------------------------------------------------------
// dropdown_rules — select/radio/yes-no. Evaluated IN ORDER; first q match wins,
// then the first opts regex matching an available option is picked. Order is
// load-bearing (sponsorship & citizenship rules must precede their generics).
// ---------------------------------------------------------------------------
const dropdown_rules = [];
const dr = (q, opts, extra = {}) => dropdown_rules.push({ q, opts, ...extra });

// --- work authorization & sponsorship ---
dr(
  "(authoriz(ed|ation)?|eligible|able).{0,80}without (the need for |need of |requiring )?(current or future |employer |visa |employer support or )*sponsor|without sponsorship now or in the future|without employer support or sponsor|without (the need for |needing |requiring )?(visa |employer )?sponsorship",
  wa.needs_sponsorship ? ['^No'] : ['^Yes'],
  { note: "Authorized to work WITHOUT sponsorship. Must precede the positive 'eligible to work' rule." }
);
if (wa.needs_sponsorship && wa.visa_type) {
  dr("what.*\\bvisa\\b|which visa|type of visa|visa.*(need|require)|specific visa",
    [esc(wa.visa_type), 'H-?1-?B', 'Employment.*visa']);
}
dr("legally authoriz|authoriz(ed|ation) to work|authorized to work|eligible to work|work lawfully|work in the (us|united states)|currently (eligible|authorized)",
  wa.authorized_to_work_us === false ? ['^No'] : ['^Yes', 'authorized', 'I am']);
dr("sponsor|visa status|require.*visa|immigration|work permit|need sponsorship",
  wa.needs_sponsorship ? ['^Yes', 'require', 'I (will|do|am)'] : ['^No', 'do not require', 'I do not']);
dr("currently (residing|located|living).*(us|united states|u\\.s)|residing in the united states|are you (currently )?(in|located|residing).*(us|u\\.s|united states)|reside in the (us|united states)|based in the (us|united states)",
  yesNo(wa.currently_in_us !== false));

// --- address sub-fields ---
if (id.state) dr("address.*\\bstate\\b|legal address.*state", [`^${esc(id.state)}( State)?$`, `^${esc(stateAbbr)}$`], { type_filter: id.state });
dr("address.*country|legal address.*country", [esc(identity.country), '^USA$', 'U\\.S\\.A'], { type_filter: identity.country });

// --- prior relationship with employer (truthful default: none) ---
dr("(ever )?interviewed with|have you (ever )?interviewed", ['^No$', '^No\\b']);

// --- residence state ---
if (id.state) dr(
  "which (u\\.?s\\.?\\s*)?state|what (u\\.?s\\.?\\s*)?state|state.*(reside|residence|of residence|located|currently|you (live|reside|based|are))|where do you (currently )?live|where do you live|state or (canadian )?province|province.*reside|state you (live|reside)|^state$|state of residence",
  [`^${esc(id.state)}( State)?$`, `^${esc(stateAbbr)}$`], { type_filter: id.state }
);

// --- US citizen / LPR / green card ---
dr("(are you )?(a )?u\\.?s\\.? citizen, lawful permanent resident|citizen, lawful permanent resident, green card|green card holder,? or asylee|citizen.*green card.*asylee",
  yesNo(!!wa.is_us_citizen_or_pr),
  { note: "Are you a US citizen / LPR / green-card / asylee. Sponsorship answers elsewhere are independent of this." });

dr("linkedin verified profile|verified linkedin profile|do you have a linkedin verified", ['^No'],
  { note: "Has a LinkedIn but not LinkedIn's identity-Verified badge. Truthful No." });

// --- technical-skill years gate (working-knowledge skills => No to "4+ yrs professional X") ---
const working = (exp.skills_working || []).map(esc);
if (working.length) {
  dr(`(at least|a minimum of|minimum of)\\s*[2-9]\\s*\\+?\\s*years.*(${working.join('|')})|years.*hands.?on.*(${working.join('|')})|professional.*experience.*(${working.join('|')})`,
    ['^No'],
    { note: "Working-knowledge skills only — no multi-year professional experience. Must precede the generic 'at least N years -> Yes' rule." });
}

dr("opt-?in.*(text|sms) message|receive.*(text|sms) message|text messages.*(number|hiring)|sms.*(hiring|process)", ['^No'],
  { note: 'Decline optional SMS opt-in by default; not required for application.' });

// --- reporting/BI tool, if a proficient one is named ---
const profSkills = (exp.skills_proficient || []).concat(exp.skills_expert || []);
const biTool = profSkills.find(s => /power\s*bi|tableau|looker|qlik/i.test(s));
if (biTool) {
  dr("automated reporting tools|reporting tools.*(experience|using|list)|experience using.*(tableau|power ?bi|looker)",
    [`^${esc(biTool)}$`, esc(biTool)],
    { note: `${biTool} is a proficient tool; other BI tools listed only as working-knowledge are not selected here.` });
}

dr("do you reside in one of the (states|following)", ['^No|None|not listed']);

// --- citizenship / nationality (MUST precede country-of-residence) ---
if (wa.citizenship) dr(
  "citizenship|country.*citizen|of which country.*citizen|which country\\/region do you have|\\bnationality\\b|national of|country of birth|export licensing.*country",
  [esc(wa.citizenship)], { type_filter: wa.citizenship, note: 'MUST stay before the residence-country rule.' }
);
dr("permanent resident in (any |an ?)?(other )?(country|region)|become a permanent resident|afterwards become a permanent|lawful permanent resident of (another|any other)", ['^No']);
if (wa.needs_sponsorship && /h-?1/i.test(wa.visa_type || '')) {
  dr("held h-?1-?b status|h-?1-?b petition approved|have you (ever )?held h-?1|previously held h-?1", ['^Yes']);
}

// --- country of residence ---
dr("country.*(reside|residence|located|based|of residence|do you live)|what country|current country|current location.*country|location.*\\(country\\)|^country",
  [esc(identity.country), '^USA$', 'U\\.S\\.A'], { type_filter: identity.country });

// --- prior employment with this company (truthful default: none) ---
dr("previously.*employ|former employee|currently.*(an )?(employee|contractor)|currently.*employ(ed)? (at|by)|ever (been )?employ|prior employ|been employed (at|by)",
  ['have not|^No$|^No\\b|never|I have not']);
dr("ever worked (for|at)|have you ever worked|currently,? or have you previously,? worked|previously,? worked (for|at)",
  ['never worked|I have never|^No$|have not|I have not']);
if (!/canada/i.test(wa.citizenship || '')) {
  dr("entitled to work in canada|authorized to work in canada|legally (entitled|authorized).*canada|work in canada", ['^No$|^No\\b']);
}

// --- compliance / conflict-of-interest (truthful defaults: none) ---
dr("personal\\/familial relationship|familial relationship|personal relationship|relationship.*(employee|official)|related to.*(employee|official)|personal ties.*(employee|official)|close personal ties", ['^No$|^No\\b']);
dr("adheres to applicable laws|government (official|entity|relation|affiliation)|political (contribution|affiliation|activity)|public official", ['^No$|^No\\b']);
if (/not a (protected )?veteran/i.test(demo.veteran_status || 'not a veteran')) {
  dr("military status", ['never served in the military|have never served|I have never served']);
}
dr("customer of|are you (a |currently a )?customer|have you (used|been a customer)", ['^No$|^No\\b']);
dr("compensation expectations align|align with the posted (range|salary)|salary.*align|expectations.*align|comfortable with (the|this) (range|compensation)", ['^Yes']);
dr("non-?compet|non-?solicit|agreement with a (former|previous) employer|subject to any agreement|restrictive covenant|preclude or restrict your employment", ['^No']);
dr("not bound by any agreement|no agreements that would limit|free to work for", ['^True$', '^Yes'],
  { note: 'Inverted phrasing of the non-compete question — True/Yes is truthful.' });

// --- professional designations ---
if (!exp.has_cpa && !exp.has_cfa) {
  dr("professional designations? or certifications?|\\bCFP\\b|\\bCFA\\b|\\bCPA\\b|\\bCRPC\\b|\\bChFC\\b", ['^No'],
    { note: 'No CPA / CFA / CFP held.' });
}

if (id.pronouns) dr("^pronouns|pronouns that you|pronouns.*addressing you|what.*pronouns",
  [`^${esc(id.pronouns)}$`, esc(id.pronouns)]);

dr("eligible to begin employment immediately|legally eligible to begin", ['^Yes']);
dr("how did you (hear|learn|find)|hear about|how were you|source|referral source|where did you (hear|learn|find)",
  ['LinkedIn', 'Company (web)?site', 'Careers', 'Online', 'Job ?board', 'Indeed', 'Search engine', 'Other']);
dr("familiar.*with.*as a company|how familiar were you|are you familiar with",
  ['familiar but not', 'Somewhat', 'A little', 'Not (very|that)', 'Slightly'],
  { note: "Never pick overclaiming options (Partner/Affiliate/power user). Truthful mid options only." });

// --- demographics / EEO (assert if set; otherwise decline) ---
const DECLINE = 'wish to answer|prefer not|decline|do not wish';
const genderOpts = { Man: ['^Man$', '^Male$', '\\bMan\\b'], Woman: ['^Woman$', '^Female$', '\\bWoman\\b'] };
dr("identify (my|as my )?gender|gender identity|^gender\\b|what is your gender|how do you (identify|describe).*gender|consider my gender|my gender as|gender as",
  genderOpts[demo.gender] || [DECLINE]);
dr("transgender", demo.transgender ? ['^Yes$', '^Yes\\b'] : ['^No$', '^No\\b']);
dr("^I identify as:?\\s*$|cisgender|gender modality",
  demo.transgender ? [DECLINE] : ['Cisgender', DECLINE]);
dr("sexual orientation|love is love|how do you identify.*orientation|identify my sexual", [DECLINE],
  { note: 'Not a recorded fact — never assert. Decline only.' });
dr("LGBTQ|member of the lgbt", [DECLINE + '|^No$']);
const raceOpts = {
  Asian: ['East Asian', 'Asian \\(', 'Asian:', '\\bAsian\\b', '^Asian'],
  White: ['White \\(', 'Caucasian', '\\bWhite\\b', '^White'],
  'Black or African American': ['Black', 'African American'],
  'Hispanic or Latino': ['Hispanic', 'Latino', 'Latinx'],
  'Native American': ['Native American', 'American Indian', 'Alaska Native'],
  'Pacific Islander': ['Pacific Islander', 'Native Hawaiian'],
  'Two or More Races': ['Two or More', 'Two or more', 'Multiracial', 'mixed'],
};
dr("race|ethnic|identify.*(race|ethnic)|which categories describe",
  raceOpts[demo.race] || [DECLINE]);
dr("hispanic|latino|latinx", demo.hispanic_latino ? ['^Yes|hispanic|latino'] : ['^No|not hispanic|not.*latino']);
const vetOpts = /protected veteran/i.test(demo.veteran_status || '')
  ? ['I (am|identify).*veteran', 'protected veteran', '^Yes']
  : (demo.veteran_status === '' ? [DECLINE] : ['not a (protected )?veteran', '^No$', '^No,', 'I am not']);
dr("veteran|protected veteran|military service", vetOpts);
const disOpts = demo.disability === true
  ? ['I have a disability', 'Yes, I have', '^Yes']
  : (demo.disability === '' ? [DECLINE] : ["do not have|don't have|without a disability|^No,", 'no, i', '^No$', '^Not disabled$']);
dr("disab", disOpts,
  { note: "'^Not disabled$' covers short-label Greenhouse EEO selects. Never let a select fall back to 'Disabled' unless truthful." });

// --- education ---
const DEGREE_LADDER = [
  ['Doctor|Ph\\.?\\s?D|Doctorate|Doctoral'],
  ["Master['’]?s", 'Master', 'Graduate degree', '\\bMBA\\b'],
  ["Bachelor['’]?s", 'Bachelor', 'Undergraduate', '\\bBA\\b', '\\bBS\\b'],
  ['Associate'],
  ['High School|GED|Secondary|Diploma'],
];
const levelIndex = (lvl) => {
  const l = (lvl || '').toLowerCase();
  if (/doctor|phd|ph\.d/.test(l)) return 0;
  if (/master|mba|graduate/.test(l)) return 1;
  if (/bachelor|undergrad/.test(l)) return 2;
  if (/associate/.test(l)) return 3;
  if (/high school|ged|secondary|diploma/.test(l)) return 4;
  return 2;
};
let eduOpts = [];
for (let j = levelIndex(edu.highest_level); j < DEGREE_LADDER.length; j++) eduOpts = eduOpts.concat(DEGREE_LADDER[j]);
dr("highest.*(education|degree)|level of education|education level|degree.*(completed|obtained|earned|hold)|education.*(complete|level)|what.*degree",
  eduOpts, { note: 'Exact level first, then lower degrees. Never offers a degree higher than highest_level.' });

// --- years of experience ---
function yearsOpts(nStr) {
  const n = parseInt(nStr, 10);
  if (!Number.isFinite(n)) return nStr ? [`^${esc(nStr)}$`] : ['^Yes'];
  const opts = [`^${n}$`, `\\b${n}\\b`];
  for (let k = n; k >= Math.max(1, n - 4); k--) {
    opts.push(`${k}\\s*\\+`, `more than ${k - 1}\\b`, `at least ${k}\\b`);
    if (k >= n - 2) opts.push(`${k}\\s*(?:-|to|–)\\s*\\d+`); // range whose lower bound is <= n (no overclaim)
  }
  return opts;
}
dr("how many years.*(experience|relevant)|years of (relevant )?experience|years.*experience do you have", yearsOpts(identity.years_experience));
dr("do you (possess|have)\\s*[1-9]\\s*\\+?\\s*(or more )?years|(at least|a minimum of|minimum of)\\s*[1-9]\\s*\\+?\\s*years|\\b[1-9]\\+ years of (progressive |relevant |of )?(experience|analy|work)",
  ['^Yes'],
  { note: 'Generic "at least N years" -> Yes (the technical-skill years rule above already caught working-skill cases).' });

// --- location / relocation / remote / onsite ---
if (id.state) dr("current location|where are you (currently )?(located|based)|what is your current location",
  [`^${esc(id.state)}( State)?$`, esc(identity.country), '^US$'], { type_filter: id.state });
dr("opt-?in.*whatsapp|whatsapp messages|receive.*text|sms", ['^No$|^No\\b']);
dr("option to work from a remote|work from a remote location|open to remote|remote.*acceptable",
  yesNo(log.open_to_remote !== false));
if (log.needs_relocation_assistance !== true) {
  dr("need relocation assistance|require relocation assistance|relocation assistance.*(need|require)|will you need.*relocat", ['^No'],
    { note: 'Distinct from "open to relocation" (below). Must precede the generic relocat rule.' });
}
dr("relocat",
  log.open_to_relocation !== false ? ['^Yes', `^${esc(id.city)}`, esc(id.city), '^Yes,'] : ['^No'],
  { note: 'If a city list (not Yes/No), your home city is the truthful pick when open to relocation.' });
dr("willing to (work|commute|relocate)|able to work (on.?site|in.?office|from)|onsite|on-site|hybrid|in.?office|report to (the|our|an) office|commute to|work in.*office|comfortable.*office|days (a|per) week.*office|acknowledge that this is a hybrid",
  log.open_to_onsite !== false ? ['^Yes', 'I acknowledge|acknowledge'] : ['^No']);

// --- language / age / consent / anti-bot ---
const engOpts = { Native: ['Native|Fluent|^Yes|Professional'], Fluent: ['Fluent|Native|^Yes|Professional'], Professional: ['Professional|Fluent|^Yes'] };
if (engOpts[demo.english_fluency]) dr('english', engOpts[demo.english_fluency]);
dr("18 years|over 18|at least 18|age of 18", ['^Yes']);
dr("background check|consent to|able to provide.*documentation|provide documentation|drug (test|screen)", ['^Yes', 'I (consent|agree|acknowledge)']);
dr("real human being|not an automated bot|not a (bot|robot)|i am a (real )?human|confirm.*human|human and not",
  ['^I Agree$', '^I agree$', '^Agree$', '^Yes'],
  { note: 'Anti-bot self-attestation. A real human applying truthfully can agree.' });
dr("were you referred|referred by (a |an )?[a-z0-9]+ employee|did (a|an|any|someone).*refer you|are you (being )?referred", ['^No$', '^No\\b'],
  { note: 'No employee referral known. Pairs with the referrer-name text rule -> N/A.' });
dr("acknowledge|consent|privacy|agree to|data processing|gdpr|certif(y|ies|ication)|hereby certify|information.*(true|accurate).*(accurate|complete)|true,? accurate,? and complete",
  ['^Yes|I (consent|agree|acknowledge)|acknowledge|accept|^Consent$|^I consent']);
dr("currently reside and work (from|in) the (u\\.?s\\.?|us|united states)|reside and work (from|in) the (u\\.?s\\.?|us|united states)|meet this location requirement|do you meet this (us |u\\.s\\. )?location requirement",
  yesNo(wa.currently_in_us !== false));

// ---------------------------------------------------------------------------
// essays + essay_rules — from profile.essays / profile.essay_keywords
// ---------------------------------------------------------------------------
const essays = { ...essaysIn };
if (!essays.general) essays.general = essays.why || 'I would welcome the chance to discuss how my experience fits this role.';
const essay_rules = [];
for (const [key, phrases] of Object.entries(kw)) {
  if (!essays[key]) continue;
  const list = Array.isArray(phrases) ? phrases : [phrases];
  essay_rules.push({ q: list.join('|'), essay: key });
}
// guarantee a catch-all so required free-text never blocks a submit
if (!essay_rules.some(r => r.essay === 'general')) {
  essay_rules.push({ q: 'tell us about|describe (a|your)|share an example|walk us through|experience (with|in)', essay: 'general' });
}

// ---------------------------------------------------------------------------
// consent checkbox + never-do guardrails (universal)
// ---------------------------------------------------------------------------
const consent_checkbox = {
  positive: "\\b(i )?(accept|consent|agree|acknowledge|authorize|certify)\\b|accept the terms|terms (and|&) conditions|privacy|i have read|to proceed",
  negative: "do not|don't|decline|opt out"
};
const never = [
  'Never blind-pick a highlighted option when no rule matches. Leave it blank.',
  'Never claim a skill, employer, title, date, or metric that is not in profile.yaml. A required gate asking for experience you lack = skip the role with a logged reason.',
  'Never present a working-knowledge skill as expert/proficient.',
  'Never answer sexual orientation with an assertion — decline option only.',
  'Never pick an overclaiming "familiarity" option (Partner/Affiliate/power user).',
];

// ---------------------------------------------------------------------------
const rules = {
  _readme: [
    'GENERATED from config/profile.yaml by src/build-rules.mjs — edit the profile, not this file.',
    'plan-apply.mjs resolves ATS questions against it; make-filler.mjs bakes it into the filler.',
    'All regexes are case-insensitive. dropdown_rules evaluate in order: first q match wins, then',
    'the first opts regex matching an available option is picked; no truthful match => left blank.',
  ],
  _generated_from: path.relative(ROOT, profilePath),
  identity, gates, text_fields, dropdown_rules, essays, essay_rules, consent_checkbox, never,
};

fs.writeFileSync(outPath, JSON.stringify(rules, null, 1));
console.log(`wrote ${path.relative(ROOT, outPath)}  (` +
  `${text_fields.length} text_fields, ${dropdown_rules.length} dropdown_rules, ` +
  `${gates.length} gates, ${Object.keys(essays).length} essays)`);

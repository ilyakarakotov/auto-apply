# LEARNINGS — the engine's prose memory of ATS quirks

This is the project's PROSE memory: reusable, person-agnostic knowledge about how each ATS behaves
and how the filler/probe must drive it. **Read it ONCE at the start of a cycle; append a new rule
after a run** (see "How to append" at the bottom). Everything here is UNIVERSAL engine knowledge —
no user's facts live here. The truth a form is filled with always comes from `config/profile.yaml`.

## Where a fix gets ENCODED (do this, don't just write prose)
A learning is only useful once it's encoded where the code reads it:
- **A new question PATTERN with a reusable answer** -> change `config/profile.yaml`, then
  `npm run build-rules` to regenerate `config/rules.json` (the ONE file every filler and the
  pre-flight planner are generated from). Never hand-edit `config/rules.json`.
- **One exact, job-specific question** -> append to `config/qa-bank.json` (`{q, value|option, src}`,
  where `src` cites the profile field the answer comes from).
- **A widget/flow mechanic** (how to open a dropdown, detect a gate, etc.) -> fix
  `src/filler.template.js` (how fields get filled) or `src/probe-form.js` (how "what's left?" /
  gates are detected). Never edit the generated `/tmp/fill-run.js`.
- After encoding, add ONE timeless line here so the next cycle inherits it.

## How the pieces fit (v2 plan-first pipeline)
- `src/discover.mjs` — ATS JSON sweep over `config/companies.json`; writes `config/search.json`
  (a JSON projection of `profile.yaml`'s `search:` block) so the in-scope filter is consistent.
  `src/build-queue.py` merges in-scope new jobs into `config/queue.yaml` (existing statuses preserved).
- `src/plan-apply.mjs` — PRE-FLIGHT (no browser): pulls the real form questions from the ATS API
  (Greenhouse `?questions=true` / Ashby GraphQL / Lever apply-page HTML), resolves them against
  `rules.json` + `qa-bank.json`, flags sponsorship gates (exit 2 = skip), prints only the unknowns.
  Exit 3 = form def unavailable -> fall back to an in-browser probe after the fill step.
- `src/make-filler.mjs` — bakes `rules.json` + the per-job plan into `/tmp/fill-run.js`
  (resume path via `--resume`).
- `src/probe-form.js` — page-context probe (`playwright-cli eval --raw`): required-empty fields,
  placeholder dropdowns, radio/checkbox groups (a group is satisfied if ANY member is checked),
  VISIBLE errors only, resume attached, captcha/email gates. Drives the submit / needs-fix decision.
- Driver loop per job: plan -> tailor -> render PDF -> fill (ONE run-code) -> probe -> targeted fix
  (max 2 rounds) -> submit -> CONFIRM real success. NEVER abandon a filled form mid-fill.

## Submission-confirmation detection (the most important rule)
Trust ONLY a real signal of success, never page prose:
- Greenhouse: `location.href` contains `/confirmation`.
- Ashby: body contains "successfully submitted".
- Lever: body contains "Application submitted".
- A bare embed form with no redirect: the submit button is gone AND a clear "thank you / application
  received" message shows.
Page text like "we appreciate your interest" appears even on UNSUBMITTED pages — never treat it as
success on its own (it has caused false "submitted" marks). A non-navigating submit click is NOT
success. Only mark `SUBMITTED` after one of the signals above.

## ATS URL shapes + career-site iframe -> embed fallback
- Apply-URL shapes: Lever = `<job-url>/apply`, Ashby = `<job-url>/application`, Greenhouse = the bare
  job page.
- Many companies' canonical Greenhouse URLs (`job-boards.greenhouse.io/<co>/jobs/<id>` or a
  `*.com/careers/...?gh_jid=<id>` link) HTTP-redirect to the company's own career site, where the
  form is wrapped in an iframe — the probe then sees `resume:false` / `submit:null`. Fallback: the
  bare embed `boards.greenhouse.io/embed/job_app?for=<co>&token=<id>` serves the same form fields
  directly (react-select, fillable the same way).
- The board token is NOT always the obvious slug. To find an unknown token, try the queue's company
  field, or probe `boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>` until it returns 200, then
  load the embed URL with that token.
- Login-walled boards (Workday tenants, iCIMS, Phenom, amazon.jobs) can't be auto-submitted — mark
  `skipped-needs-login` before tailoring.

## Greenhouse react-select dropdowns
Greenhouse dropdowns are react-select. DOM (innermost -> outermost): `input.select__input[role=combobox]`
(a real searchable `<input>`, not readonly) -> `.select__value-container` -> `.select__control`
(THE clickable opener; gets `--is-focused` / `--menu-is-open`). When open, the menu renders INLINE
(no portal) as `.select__menu > .select__menu-list > .select__option[role=option]`; the chosen value
shows in `.select__single-value`.

Reliable interaction sequence (mid-form safe):
1. DEFOCUS first (Escape + click an empty body corner). Stuck focus from the previous field is the
   #1 cause of "the next dropdown won't open."
2. Click the `.select__control` div, NOT the input.
3. WAIT for `.select__menu` to be visible (it has `transition: all`; clicking mid-animation is dropped).
4. Pick the option SCOPED to `.select__menu` (`menu.getByRole('option', {name})`). Do NOT use a
   page-wide `[role=option]` match — the phone-country widget exposes ~249 `[role=option]` entries and
   will collide.
5. VERIFY `.select__single-value` shows a value (control no longer reads "Select...") before moving on;
   retry up to 3x. On a stubborn one, type the option text to filter, then pick.
- A plain JS `.click()` / `mousedown` dispatch sometimes will NOT open a react-select; if so a real
  mouse click on the dropdown-indicator coordinates (getBoundingClientRect -> mousemove/down/up) opens it.

## Phone country (intl-tel-input, NOT react-select)
Its own widget. Click it and pick the country from the list (e.g. the profile's `phone_country`) — do
NOT type to filter (typing breaks this widget and the broken state cascades to later fields). The value
renders short (e.g. `+1`), so detect "filled" by the ABSENCE of the `Select...` placeholder, NOT by
requiring 2+ characters (that false-flagged it as empty and blocked auto-submit). After picking, re-type
the phone number to force Greenhouse re-validation.

## Email-verification gate (Greenhouse 8-char code) — solvable end-to-end
Many Greenhouse forms gate submit behind a code emailed to the applicant ("a verification code was
sent ... enter the N-character code to confirm you're a human"). This is now the DEFAULT expectation for
GH embed forms, not the exception. It appears only AFTER the submit click, so the pre-flight planner
can't pre-flag it; the probe reports `gates:["email-verification"]`.
- **The email on the form and the inbox you poll MUST be the same address.** The code only lands
  somewhere readable because the form carries `profile.yaml` -> `identity.email`, and that is the inbox
  `config/email-imap.json` reads. Keep them in sync.
- Procedure: `node src/check-email-code.mjs <company> --wait --code-only` polls IMAP up to ~60s and
  prints ONLY the code. Code printed -> fill the verification input, submit, RE-CONFIRM real success
  (see confirmation rules) -> `mark-status SUBMITTED`. Empty after 60s -> `mark-status SKIPPED-EMAIL-GATE`,
  reuse the tab. NEVER loop, NEVER mark SUBMITTED on an unconfirmed code.
- **The split inputs need REAL keyboard typing.** The 8 boxes (`#security-input-0..7`) are
  React-controlled: setting `.value` + dispatching input/change events fills the visible chars but does
  NOT enable "Submit application" (React state never registers). Focus the first box, then type the code
  with real keyboard events — the widget auto-advances across the boxes and flips submit enabled. Do NOT
  JS-set the values.
- **Subject-match to avoid a shared-inbox collision.** If multiple applications share one inbox, sort by
  newest-uid alone returns the WRONG company's code (which then fails as "incorrect security code" and
  looks like a re-issue loop). Match the email by the company's REAL DISPLAY name (the ATS subject uses
  the display name, not the queue slug); GH issues ONE code per application, so the first subject-matching
  code is the valid one.
- **A transient "There was an error processing your application" re-issues a new code** on each retry,
  making the previous code stale. Clear the inputs, fetch the FRESHEST subject-matching code, re-enter.

## Greenhouse education sub-fields (a common silent failure)
- The education react-selects (School / Degree / Discipline) and the start/end month+year fields are
  often NOT in the planner's question list, but the probe flags them required-empty (`emptyDrop`). Fill
  School/Degree/Discipline via the react-select sequence above; fill the month/year fields too.
- School typeahead lists frequently use a school's CANONICAL or older name — picking the same institution
  under its other name is truthful.
- A PARTIAL education entry silently invalidates the WHOLE entry: a filled School/Degree/months but EMPTY
  start/end YEAR makes GH submit fail with a generic "There was an error processing your application" and
  NO field-level error. When an email-gated GH submit loops on that generic error with a valid code, check
  the start/end YEAR fields are filled, not just the months.
- Conversely, a generic notice/start-date text rule must NEVER write into the optional education
  "Start date year" textbox — junk there silently invalidates the entry. The filler skips elements whose
  id matches `^(start|end)-date-(month|year)-` or `^(school|degree|discipline)-`, or whose aria-label is
  "Start/End date month/year" (encoded in `src/filler.template.js`).
- GH embed forms sometimes add a "Legal First/Last Name" pair the generic First/Last rule leaves empty
  (it fills the standard fields first). Fill the Legal* fields explicitly by walking from the `<label>`
  to the nearest input when there's no for=/aria association.

## Probe false-positive on a filled react-select (fixed in probe-form.js)
A react-select's search input stays an empty `[role=combobox]` even after a value is chosen, so a naive
"required input with empty value" scan false-flags every REQUIRED react-select and blocks `ok:true`. The
probe skips a `[role=combobox]` whose `[class*=control]` shows a `single-value`/`multi-value` (or no
"Select..." placeholder). Keep this guard if you ever touch the empty-text loop.

## Ashby (jobs.ashbyhq.com/<co>/<id>/application)
Mostly standard labeled `<input>`/`<textarea>` (label-based fill works) plus several widgets the generic
handlers must cover. ALWAYS do a trial Submit on Ashby and read the "Missing entry for required field"
banner — `probe ok:true` is NOT sufficient for Ashby's button/radio widgets.
- **EEO RADIO groups** (gender/race/veteran): check the option by label text.
- **Yes/No BUTTON widget**: rendered as a `<button class="_option_...">Yes</button>` / `No` pair, NOT a
  react-select or radio; the selected one gets the `_active_` class (no `aria-pressed`). The closest
  ancestor holding both buttons is just the options wrapper (its text is "YesNo" with no question), so
  climb until an ancestor also carries the question label (length > 12). These Boolean fields arrive in
  the plan as `{value:"Yes"}` (kind:select), not `{option}`, so the handler checks `plan.value` too. The
  probe reports `emptyButtons[]` (a required pair with neither `_active_`) and folds it into `ok`.
- **MultiValueSelect / labeled-checkbox lists** ("Where did you hear about this job?", "I Acknowledge"):
  rendered as a list of labeled-checkbox options, NOT a react-select. Setting the underlying
  `input[name=<Option>]` to "on" does NOT toggle React's `checked` state -> submit fails "Missing entry
  for required field". FIX: real-click the option's checkbox container span and VERIFY `input.checked === true`.
- **Name/email fields** use the same "Type here..." placeholder as everything else, so a label-match can
  miss them (probe shows `emptyText:["Name"]`). Fill them by their `_systemfield_name` / `_systemfield_email`
  selectors with real keyboard typing (Ashby is React-controlled).
- **A "without sponsorship" clause is sometimes a single labeled CHECKBOX**, not a Yes/No widget ("I am
  authorized to work in my country of residence without sponsorship"). For a profile that needs
  sponsorship, leave it UNCHECKED (checking it is a false affirmation). Always read the FULL checkbox
  label for a "without sponsorship" clause before checking.
- **Location** is a Google-Places-style autocomplete; the geocoder rate-limits/flakes on a datacenter IP.
  Type a city, wait ~3.5s, read the listbox; if "No results", clear and retry 2-3x (try the city alone vs
  city + region). Only give up after several real retries — it's flaky, not a hard block.
- **Resume can DETACH between fill and submit** -> re-check for "Missing ...: RESUME" and re-upload to the
  resume file input right before submit.

## Lever (<job-url>/apply)
- The apply form lives at `<job-url>/apply`; the bare job URL is just the posting.
- **EEO uses native `<select>` elements** (Gender/Race/Veteran/Disability), NOT react-select — handle
  with `selectOption` by partial option text (the react-select handler skips native selects).
- **The CC-305 / disability self-ID section adds required `Name` + `Date` text fields** (only required
  once disability is answered) — fill Name = `identity.full_name`, Date = today.
- **A hidden error template stays in the DOM always** (e.g. "File exceeds 100MB"). Count only errors where
  `offsetParent !== null` (visible). The probe already does this; keep it.
- **Submit is often gated by INVISIBLE hCaptcha** (passive mode: no visible challenge; it risk-scores the
  session and silently fails low-trust/automated browsers). With the anti-bot hardening below in place,
  the deciding remaining signal is the datacenter IP — clicking Submit fires only hCaptcha config calls and
  no `POST .../apply` ever goes out (the button just resets). One genuine fill + submit attempt, then
  `SKIPPED-CAPTCHA`. Only a residential/mobile proxy moves this; never re-introduce headless to "fix" it.

## Workable (apply.workable.com)
- Form URL = `<job-url>/apply/` (the bare `/j/<CODE>/` page hides the form behind an "Apply for this job"
  link).
- **Submit is gated by Cloudflare Turnstile** (not hCaptcha) — same class of block. On a datacenter IP the
  "Submit application" button hangs on "Submitting…" indefinitely (the resume PUT to S3 returns 204 but the
  app POST never completes because `challenges.cloudflare.com` never returns a passing token), or the click
  silently no-ops. Treat as `SKIPPED-CAPTCHA` after one genuine attempt. Detect: button stuck on
  "Submitting…" + a `challenges.cloudflare.com` request.
- Filler quirks (if Workable becomes worth it post-proxy): a `position:fixed; z-index:999999` cookie banner
  intercepts the submit click — dismiss "Accept all" FIRST. Navigating away triggers a `beforeunload`
  dialog — accept it before the next probe. Inputs need REAL keyboard `type` (native value-set / `.fill()`
  do NOT register Workable's controlled React state for custom fields). Custom screening questions are
  `textarea[name=QA_<id>]` (essay) or a react-select combobox in `div[data-input-type=select]` (open + real-
  click the option, don't type). There are often TWO `input[type=file]` (optional photo + required resume) —
  attach to the required one and re-verify `files.length > 0` right before submit.

## SmartRecruiters (jobs.smartrecruiters.com/<co>/<id>)
- The JD is fetchable via `api.smartrecruiters.com/v1/companies/<co>/postings/<id>` (JSON) — use it to
  triage gates BEFORE opening a browser. But the apply FORM is client-rendered, so the API returns 0 apply
  questions and the planner shows "0 questions" — you MUST probe in-browser.
- The "I'm interested" button redirects to a `oneclick-ui` apply built on Salesforce Lightning web
  components (custom elements with shadow DOM). Mechanics: personal fields are accessibility-ref'd textboxes
  (fill by ref; confirm-email may need click+type — watch for a DOUBLE-fill that concatenates the value);
  the resume file input lives in shadow DOM (`input[type=file][accept*=".resume"]`) — `setInputFiles` on it
  attaches AND auto-fills Experience/Education from the PDF; consent checkbox + Submit are refs. Success =
  URL ends `/success` + "Application submitted successfully".

## Answer-resolution rules (truth-only; values come from config/profile.yaml)
These are about HOW to resolve, never WHAT a specific person answers — the value is always derived from
`profile.yaml` via `build-rules`.
- **NEVER blind-pick a highlighted option.** Pressing Enter on the highlighted react-select row when
  nothing matches a truthful rule once selected a false answer ("Yes, as a former employee"). If no option
  matches, leave the field BLANK for the probe to surface.
- **NEVER use a "pick first option" fallback on EEO/disability/veteran/race selects** — short labels like
  "Disabled" / "Not disabled" / "Prefer not to say" make a first-option fallback assert a false statement.
  Match the truthful option from the profile; for multi-value selects, removing a wrong chip then selecting
  ADDS rather than replaces, so clear the wrong chip first.
- **"without sponsorship" phrasing must resolve via the gate, never the auto-answer.** "Are you eligible /
  authorized / able to work WITHOUT (the need for) visa sponsorship?" is a sponsorship gate — for a profile
  that needs sponsorship it is truthfully **No**. A plain "authorized to work?" (no "without") is a
  different question. The gate regex must catch `(authoriz(ed|ation)?|eligible|able).{0,80}without ...
  sponsor` plus a catch-all `without (the need for|needing|requiring)? (visa|employer)? sponsorship` and run
  BEFORE the positive "authorized/eligible to work" rule. NEVER trust the auto-resolved answer on a
  "without sponsorship" phrasing.
- **Rule ORDER matters** in `rules.json` (so order the source in `profile.yaml` / `build-rules` accordingly):
  citizenship/nationality questions must resolve from `work_authorization.citizenship` BEFORE the
  residence/located rule resolves country; a "without sponsorship" gate before "authorized to work";
  "need relocation assistance?" (resolve from `logistics.needs_relocation_assistance`) before a generic
  open-to-relocation rule; education must match the profile's highest level FIRST (e.g. match Master/MBA
  before Bachelor AND before Doctoral — a Doctoral mis-match has been observed).
- **A state-name dropdown rule must anchor exactly** (`^<State>$`). An unanchored state name can match a
  similarly-named option in the list (a state whose name is a substring of "District of Columbia
  (... DC)" or appears with a ", D.C." suffix) and pick the wrong region. Use exact anchors and pick the
  exact option label (some lists prefix region, e.g. "(US) <State>").
- **Technical-skill year gates** ("Do you have at least 4 years of hands-on SQL/Python/programming?") must
  NOT match the generic "(at least|a minimum of) N years -> Yes" rule. A skill in `experience.skills_working`
  (familiar-only) resolves these to **No**; a `skills_expert` skill can resolve Yes. Put the technical-skill
  exclusion BEFORE the generic years rule.
- **Familiarity questions often have OVERCLAIMING options** ("Yes, I'm a <Company> Partner/Affiliate").
  Never pick an overclaim; pick the truthful non-overclaiming option. Don't blindly match `/^Yes/`.
- **"Open to relocation?" is sometimes a CITY LIST, not Yes/No.** If so, pick the job's city only when the
  profile's location matches it; never default to the first `/^Yes/`.
- **Split address fields** (Street Address 1 / Street Address 2 / City / State / Zip): order the text rules
  so the specific ones (`address.*zip`, `address.*city`, `street address ?2`) match BEFORE the broad
  `legal address|street address` line-1 rule — otherwise the broad rule greedily fills line 2 and zip with
  the street line. Add dropdown rules for `address.*state` / `address.*country` (the generic state/country
  rules don't match "Legal Address - State" labels).
- **A required Cover Letter is not always surfaced by the planner.** It can show as a post-submit error
  "Cover Letter is required." Fix: click the cover-letter section's "Enter manually" button (the one whose
  ancestor text matches /cover letter/i, not Resume/CV), fill the cover-letter text, re-submit.

## Checkbox-GROUP handling
Some forms mark EVERY option in a multi-select list (e.g. a ~197-country list, or "select all that apply"
demographics) as `required`. The probe groups required checkboxes by `name` and treats a group as
satisfied if ANY member is checked — otherwise it false-blocks submit. The filler's single-consent
checkbox pass must SKIP grouped checkboxes (siblings > 1) and let the group pass handle them. Keep both.

## Hard gates that mean SKIP (one attempt, then move on)
- **CAPTCHA (image/audio), visible reCAPTCHA Enterprise checkbox, hCaptcha, Cloudflare Turnstile**: no
  solvers. A visible reCAPTCHA Enterprise checkbox will NOT accept programmatic/synthetic clicks and shows
  no solvable challenge. reCAPTCHA is score-based, not deterministic by URL — always attempt submit first;
  only skip once a blocking challenge actually appears. On some hosts the new `job-boards.greenhouse.io` UI
  fails reCAPTCHA via a CSP/endpoint mismatch (token never generated, submit returns HTTP 428) — same
  `SKIPPED-CAPTCHA`. Status: `SKIPPED-CAPTCHA`.
- **Login wall** (account required to apply): `skipped-needs-login`.
- **A required screening gate the profile can't answer truthfully** (a specific years/skill requirement,
  CPA/CFA the profile lacks, US-citizenship/security-clearance/ITAR/export-control requirement the profile
  doesn't meet, a JD that states it won't sponsor): SKIP with the right reason
  (`SKIPPED-POOR-FIT` / `SKIPPED-NO-SPONSORSHIP`). A JD's no-sponsorship clause is prose the planner can't
  see — read it when triaging. Never answer a gate falsely to get past it.

## Anti-bot hardening (automatic — never disable)
Invisible/passive hCaptcha and Cloudflare Turnstile show no challenge; they risk-score the session and
silently fail low-trust browsers at submit. Two mitigations are baked in and apply to every run, so do
NOT add `--headless` or `--enable-automation` and never launch a Playwright-managed Chromium for applying
(both spike the score): (1) Chrome launches REAL headed with `--disable-blink-features=AutomationControlled`
and a persistent profile; (2) `src/filler.template.js` step 0 patches `navigator.webdriver` -> undefined
on every page (`addInitScript` for captcha iframes + `evaluate` for the live top frame). Patch ONLY
webdriver — this is real headed Chrome, so languages/plugins/webgl are already genuine and faking them
HURTS. The remaining hard signal is the datacenter IP; some Lever/Workable forms still block -> a residential
proxy is the only lever left. Keep the hardening regardless (it's free and helps elsewhere).

## How to append (self-improvement protocol)
After a run, if you learned something the code didn't already know:
1. ENCODE it where the code reads it (profile.yaml + `npm run build-rules`, or `qa-bank.json`, or
   `src/filler.template.js` / `src/probe-form.js`) — prose alone changes nothing.
2. Add ONE timeless rule line to the right section above (or a new `##` section). Generalize it: state the
   ATS behavior and the fix, NOT a specific company, person, location, or dated run-log. If you found it on
   "AcmeCo on 2026-XX-XX", write the rule that AcmeCo happened to reveal.
3. Keep it terse and person-agnostic. No emojis, no em-dashes. The next cycle reads this file ONCE at start.

# Auto-Apply Engine

A configurable, open-source job-application pipeline. You describe yourself once in a single
`profile.yaml` — who you are, what roles and locations you want, your work-authorization
situation, your honest skills — and the engine **discovers** matching jobs across the major ATS
platforms, **plans** each application by resolving its real form questions against your profile,
**fills** the form in a real browser, and **submits** on the employer's own site.

It's designed to be driven by [Claude Code](https://claude.com/claude-code) + Playwright: the
scripts do the deterministic work (sweeping boards, resolving questions, filling forms, verifying)
and the agent supplies judgment (light resume tailoring, novel one-off questions, confirming a
submit). A daily orchestrator can run the whole loop unattended.

> **Truth-only by design.** The engine never fabricates. Every value it types comes from your
> `profile.yaml`. If a form asks something your profile doesn't answer, the field is left blank and
> — if it's a required gate — the job is skipped with a logged reason, never guessed.

## How it works

```
                config/profile.yaml  ──(npm run build-rules)──►  config/rules.json
                        │                                              │
   ┌────────────────────┼──────────────────────────────────┐         │ (universal ATS question
   ▼                    ▼                                    ▼         ▼  regexes + YOUR answers)
discover ──► build-queue ──► next-jobs ──► plan-apply ──► make-filler ──► fill (browser) ──► submit
(sweep ATS    (in-scope     (pull N        (resolve form   (one-shot       (probe-form        (on the
 JSON APIs)    filter +      ready jobs)    questions, no   Playwright      verifies, then     employer
               dedupe +                     browser)        filler)         submit)            ATS)
               merge)
```

1. **discover** (`src/discover.mjs`) sweeps every company in `config/companies.json` across
   Greenhouse, Lever, Ashby, SmartRecruiters and Workable via their public JSON endpoints, keeping
   only roles that match your `target_roles` and `target_locations`.
2. **build-queue** (`src/build-queue.py`) applies the in-scope filter, dedupes against what you've
   already done, and merges new jobs into `config/queue.yaml` (existing statuses are preserved).
3. **plan-apply** (`src/plan-apply.mjs`) fetches a job's real form definition straight from the ATS
   API and resolves every question against `config/rules.json` — no browser needed. It flags
   sponsorship gates (skip) and lists the few genuinely-unknown questions.
4. **make-filler** (`src/make-filler.mjs`) bakes your answers into a single Playwright script that
   fills the whole form in one pass; **probe-form** (`src/probe-form.js`) verifies what's left in
   ~10 lines of JSON before submit.

`config/rules.json` is **generated** from `profile.yaml` by `src/build-rules.mjs`. The universal
part — *how* an ATS phrases "are you authorized to work?", "gender", "veteran status", "how many
years of experience?" — is engine knowledge. The *answers* are all yours, from the profile.

## Quick start

```bash
# 1. Install
npm install
npx playwright install chromium      # for HTML/Markdown -> PDF resume rendering

# 2. Configure yourself (interactive)
npm run init
#    ...then open config/profile.yaml and complete it honestly
#    (address, skills, demographics, essays), and:
npm run build-rules                   # regenerate config/rules.json after any profile edit

# 3. Add companies to sweep — edit config/companies.json (a plain data file)

# 4. Fill the queue with today's matching jobs
bash scripts/discover-daily.sh

# 5. Apply — point Claude Code at this directory and let it work the queue per CLAUDE.md,
#    or run the unattended orchestrator:
bash scripts/daily-orchestrate.sh     # discover -> plan -> apply -> review
```

The browser work needs a headed Chrome. On a headless box (VPS/CI), `bash scripts/vps-up.sh`
brings up a virtual display + real `google-chrome-stable` over CDP (and an optional noVNC view so
you can watch or take over). Headed real Chrome with a persistent profile keeps the hCaptcha
bot-score low — see the note in `scripts/start-chrome-linux.sh`.

## The profile model

`config/profile.yaml` is the one file you maintain. It drives both discovery and form-filling.
See `config/profile.example.yaml` for the fully-commented schema. The main sections:

| Section | Drives |
| --- | --- |
| `identity` | Name, email, phone, address, LinkedIn — typed verbatim into forms |
| `work_authorization` | Every visa / sponsorship / citizenship question (incl. auto-skip of no-sponsorship roles) |
| `education`, `experience` | "Highest degree", "how many years", honest skill levels |
| `demographics` | Voluntary EEO sections (any field blank = "decline to answer") |
| `search` | What discovery finds: `target_roles`, `target_locations`, exclusions |
| `essays` + `essay_keywords` | Long free-text answers, matched to questions by keyword |

Two situations the engine handles out of the box:

- **No sponsorship needed** (US citizen / permanent resident): answers work-authorization
  questions Yes and sponsorship-needed questions No.
- **Needs sponsorship** (e.g. an H-1B transfer): answers "authorized *without* sponsorship?"
  truthfully No, declares the visa type, and *skips* roles that explicitly won't sponsor — because
  applying to those is futile, not because of any dishonesty.

## Project layout

```
config/
  profile.example.yaml   fully-commented schema (copy/seed your real profile.yaml from this)
  companies.example.json starter ATS company list
  (generated: profile.yaml, rules.json, search.json, qa-bank.json, queue.yaml, companies.json)
src/
  build-rules.mjs        profile.yaml -> rules.json generator (the core of the generalization)
  discover.mjs           ATS JSON sweeper
  build-queue.py         in-scope filter + queue merge
  next-jobs.mjs          compact "give me N ready jobs" reader
  plan-apply.mjs         per-job form-question resolver (no browser)
  make-filler.mjs        builds the one-shot Playwright filler
  filler.template.js     the form-filling logic (general; CFG injected by make-filler)
  probe-form.js          post-fill verification probe
  html-to-pdf.mjs        resume Markdown/HTML -> Letter PDF
  mark-status.mjs        atomic queue status updates
  check-email-code.mjs   optional: clear email-verification gates via IMAP
scripts/
  vps-up.sh              headed-browser stack for headless boxes
  start-chrome-linux.sh  the Chrome launcher (anti-bot posture)
  discover-daily.sh      one-command queue refresh
  daily-orchestrate.sh   unattended discover -> plan -> apply -> review loop
bin/
  init.mjs               the setup wizard
CLAUDE.template.md       operating manual template ({{placeholders}} -> CLAUDE.md by the wizard)
```

## Requirements

- Node.js >= 18, Python 3
- `npx playwright install chromium` (resume PDF rendering)
- `google-chrome-stable` for the actual form-filling (headed, real Chrome — not Playwright's
  bundled Chromium, by design)
- For unattended runs: the `claude` CLI and `tmux`
- Optional: `config/email-imap.json` to auto-clear email-verification gates

## Responsible use

This tool submits real applications under your name. Use it honestly: keep `profile.yaml` truthful,
apply to roles you'd actually take, and respect each site's terms. It applies only on employers'
own ATS pages (never LinkedIn/Indeed automation), spaces out requests, and never solves CAPTCHAs or
defeats login walls — those jobs are simply skipped.

## License

MIT — see [LICENSE](LICENSE).

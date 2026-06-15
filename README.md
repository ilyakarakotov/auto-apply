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

> **New here?** [GUIDE.md](GUIDE.md) is a step-by-step, local-laptop-first walkthrough from an
> empty checkout to your first submitted application.

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

## Quick start (local laptop)

```bash
# 1. Install
npm install                          # also installs playwright-cli (npx playwright-cli)
npx playwright install chromium      # bundled Chromium — used only to render your resume PDF

# 2. Verify your toolchain + config at any time
npm run doctor                       # ✓/✗ checklist (Node, Python, Chrome, playwright-cli, ...)

# 3. Configure yourself (interactive)
npm run init                         # writes config/profile.yaml, rules.json, CLAUDE.md, a starter
                                     #   resume at applications/_resumes/resume-base.md, and more
#    ...then open config/profile.yaml and complete it honestly (address, skills, demographics,
#    essays), replace the starter resume with your own, and:
npm run build-rules                  # regenerate config/rules.json after any profile edit

# 4. Add companies to sweep — edit config/companies.json (a plain data file)

# 5. Start a real headed Chrome locally and attach to it
npm run browser                      # bash scripts/start-chrome.sh — Chrome on CDP 9222
#    log into LinkedIn / any company SSO once in that window (cookies persist), then:
#    playwright-cli attach --cdp http://localhost:9222

# 6. Fill the queue with today's matching jobs
npm run discover-daily

# 7. Apply — open Claude Code in this directory and run the slash command:
#    /apply
#    ...or run the unattended orchestrator:
npm run orchestrate                  # discover -> plan -> apply -> review
```

## Driving it with Claude Code

This repo ships a `.claude/` directory so an agent has everything it needs out of the box:

- **Slash commands** (`.claude/commands/`): **`/apply`** runs a full cycle (discover → work the
  ready queue → tally); **`/pre-answer`** truthfully pre-banks screening answers (no browser, no
  submit); **`/day-review`** audits the last run and fixes any wrong rule at its source.
- **Permission allowlist** (`.claude/settings.json`): pre-approves the safe hot path (`node src/*`,
  `python3 src/*`, `bash scripts/*.sh`, the `playwright-cli` subcommands, the localhost CDP check)
  so unattended runs don't stall on prompts. Put machine-specific overrides in the gitignored
  `.claude/settings.local.json`.
- **playwright-cli skill** (`.claude/skills/playwright-cli/`): the agent's documented "hands" on
  the browser. `playwright-cli` is `@playwright/cli` — installed as a dev dependency (so
  `npx playwright-cli` works after `npm install`) or globally with `npm i -g @playwright/cli`.
- **`CLAUDE.md`** (generated by `npm run init` from `CLAUDE.template.md`): the agent's operating
  manual, tailored to your profile. **`LEARNINGS.md`** is the engine's prose memory of universal
  ATS quirks — the agent reads it once per cycle and appends a generalized rule after a run.

## Discovery — casting the widest truthful net

```bash
npm run discover-daily               # the one command: live sweep of config/companies.json + merge
```

Grow the company list however you like — it's just data:

- **From the web:** search `site:job-boards.greenhouse.io "<your role>" (<your city> OR remote)`
  (and the lever/ashby/smartrecruiters/workable variants), save the results page, then
  `npm run harvest -- --extract <file>` to merge the slugs into `config/companies.json`
  (`-- --names <file>` probes a company-name list instead).
- **jobhive (optional, much wider net):** `npm run sync-jobhive` pulls validated live board slugs
  into an optional `config/companies-universe.json`; `npm run jobhive` queries jobhive's
  pre-scraped multi-million-job dataset directly (needs the `duckdb` Python module) — the easiest
  way to surface SmartRecruiters/Workable roles your curated list misses.
- **Universe rotation:** when `config/companies-universe.json` exists, each `discover` run sweeps a
  rotating batch of it and *promotes* any slug that yields an in-scope role into `companies.json`.
  `npm run sweep-universe` does a full memory-safe pass in resumable shards.
- **Login-walled boards** (Workday tenants, iCIMS, Phenom, amazon.jobs) can't be auto-submitted —
  the agent parks them in `config/manual-apply.yaml` for you to do by hand.

## Applying: interactive or unattended

- **Interactive (best for your first runs):** open Claude Code and run `/apply`. Set
  `REVIEW_ONLY=1` to fill each form and stop before submitting, so you can eyeball the result.
- **Unattended, full loop:** `npm run orchestrate` (`scripts/daily-orchestrate.sh`) runs
  discover → plan → apply → review as disposable Claude sessions, routing a capable model to the
  judgment seams and a fast model to the volume. `N=5 npm run orchestrate` caps the run;
  `DRY=1 npm run orchestrate` plans without spawning anything.
- **Unattended, volume only:** `npm run batch` drains the ready pool in batches.
- **Scheduled:** `npm run nightly` (`scripts/run-nightly.sh`) wraps the orchestrator with
  cron-friendly PATH + logging. Unattended runs need the `claude` CLI and `tmux` on PATH.
- **Large queues:** for a very large ready pool, `scripts/worker-browser.sh <N>` launches an
  isolated headed Chrome per worker (own CDP port + profile). Default is a single session.

## Outcome tracking

Once `config/email-imap.json` is set, `npm run followups` (`src/scan-followups.py`) polls your
apply inbox, *conservatively* classifies employer replies (interview / OA / offer / rejection /
ghosted), matches them to your `SUBMITTED` rows, and writes the trailing `followup_status` column
in `tracker.csv`. It prints a plain digest (no notifier wired in), is idempotent, and supports
`--dry-run`. Wire it into cron for a daily check.

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

## Email-verification gates (optional)

Some ATSes (e.g. Greenhouse) email a short code mid-apply. Add `config/email-imap.json`
(`{ "user": "...", "password": "<app password>", "host": "imap.gmail.com", "port": 993 }`) and the
engine clears those gates automatically via `src/check-email-code.mjs`. On a shared inbox,
`src/get-code-by-subject.mjs` matches the code by email subject; `src/retry-email-run.mjs` re-fetches
a guaranteed-fresh code. Without that file, those jobs are simply marked `SKIPPED-EMAIL-GATE`.

## Running on a headless server (scale-up)

The browser work needs a headed Chrome. On a headless box (VPS/CI), `npm run browser:vps`
(`scripts/vps-up.sh`) brings up a virtual display + real `google-chrome-stable` over CDP (and an
optional noVNC view so you can watch or take over). Headed real Chrome with a persistent profile
keeps the hCaptcha bot-score low — see `scripts/start-chrome-linux.sh`.

## Project layout

```
config/
  profile.example.yaml          fully-commented schema (seed your real profile.yaml from this)
  resume-base.example.md        starter resume (init copies it to applications/_resumes/)
  companies.example.json        starter ATS company list
  companies-universe.example.json  optional large unproven-slug list (shape reference)
  manual-apply.example.yaml     login-walled / manual-only jobs (shape reference)
  queue.example.yaml            what a populated queue.yaml looks like
  (generated/private: profile.yaml, rules.json, search.json, qa-bank.json, queue.yaml,
   companies.json, companies-universe.json, manual-apply.yaml, email-imap.json)
src/
  build-rules.mjs               profile.yaml -> rules.json generator (the core of the generalization)
  discover.mjs                  ATS JSON sweeper
  build-queue.py                in-scope filter + queue merge
  next-jobs.mjs                 compact "give me N ready jobs" reader (uses src/lib/csv.mjs)
  plan-apply.mjs                per-job form-question resolver (no browser)
  make-filler.mjs / filler.template.js   one-shot Playwright filler (CFG injected from rules.json)
  probe-form.js                 post-fill verification probe
  html-to-pdf.mjs               resume Markdown/HTML -> Letter PDF
  mark-status.mjs               atomic queue status updates
  check-email-code.mjs / get-code-by-subject.mjs / retry-email-run.mjs   email-gate helpers (IMAP)
  scan-followups.py             post-submission outcome classifier (writes followup_status)
  sync-jobhive.mjs / discover-jobhive.py   jobhive slug sync + pre-scraped dataset query
  harvest-tokens.mjs            grow companies.json from saved web-search results
  lib/csv.mjs                   dependency-free CSV parse/write
scripts/
  start-chrome.sh               local headed Chrome (macOS/Linux) — the default browser path
  vps-up.sh / start-chrome-linux.sh   headless-server browser stack (scale-up)
  worker-browser.sh             isolated headed Chrome per parallel worker
  discover-daily.sh             one-command queue refresh
  daily-orchestrate.sh          unattended discover -> plan -> apply -> review loop
  batch-loop.sh                 volume-only apply loop
  run-nightly.sh                cron-friendly nightly wrapper
  sweep-universe.sh             full companies-universe.json pass in shards
bin/
  init.mjs                      the setup wizard
  doctor.mjs                    preflight toolchain + config check (npm run doctor)
test/                           node:test specs + the followups classifier test (npm test)
.claude/                        slash commands, permission allowlist, playwright-cli skill
CLAUDE.template.md              operating manual template ({{placeholders}} -> CLAUDE.md by the wizard)
LEARNINGS.md                    the engine's prose memory of universal ATS quirks
GUIDE.md                        step-by-step human walkthrough
```

## Requirements

- Node.js >= 18, Python 3
- A real **Google Chrome / Chromium** for the form-filling (headed, with a persistent profile — not
  Playwright's bundled Chromium, by design)
- **`playwright-cli`** (`@playwright/cli`) — the agent's browser hands. Installed as a dev
  dependency by `npm install` (use `npx playwright-cli`), or globally: `npm i -g @playwright/cli`
- `npx playwright install chromium` (for resume PDF rendering)
- For unattended runs: the `claude` CLI and `tmux`
- Optional: `config/email-imap.json` (email-verification gates + outcome tracking);
  the `duckdb` Python module (`pip install duckdb`) for the jobhive dataset path
- Run `npm run doctor` to check all of the above at once.

## Testing

```bash
npm test                  # node:test specs (csv, build-rules, check-email-code)
npm run test:followups    # the scan-followups classifier (python stdlib unittest)
```

## Responsible use

This tool submits real applications under your name. Use it honestly: keep `profile.yaml` truthful,
apply to roles you'd actually take, and respect each site's terms. It applies only on employers'
own ATS pages (never LinkedIn/Indeed automation), spaces out requests, and never solves CAPTCHAs or
defeats login walls — those jobs are simply skipped.

## License

MIT — see [LICENSE](LICENSE).

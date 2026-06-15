# A Friendly Walkthrough: Driving Auto-Apply with Claude Code

This is the hand-held tour. The [README](README.md) explains *what* the engine is and how the
pieces fit; this guide walks you from an empty checkout to your first real submitted application,
on your own laptop, step by step. If you get stuck, jump to [Troubleshooting](#9-troubleshooting).

The short version: you describe yourself once in `config/profile.yaml`, the scripts discover
matching jobs and resolve each form's questions against your profile, and Claude Code drives a
real Chrome window through the application and submits on the employer's own site. Everything runs
locally on your machine.

> **The truth-only contract.** The engine never makes anything up. Every value it types comes
> from your `config/profile.yaml`. If a form asks something your profile doesn't answer, the field
> is left blank; if that field is a required gate, the job is skipped with a logged reason. Fill
> your profile out honestly and completely — that is the whole safety model.

---

## 1. Prerequisites

You need these on your machine before anything works:

- **Node.js 18+** — the scripts and the form-filler run on Node. ([nodejs.org](https://nodejs.org))
- **Python 3** — `build-queue.py` (the in-scope filter) uses it.
- **Google Chrome** — the *real* browser the engine drives. Not Playwright's bundled Chromium;
  a real, logged-in Chrome with a persistent profile is what keeps the bot-score low.
- **playwright-cli** — Claude's hands on the browser. Install globally:
  `npm install -g @playwright/cli@latest` (then `playwright-cli --version` to confirm).
- **Claude Code** — the agent that does the judgment and the clicking.
  ([claude.com/claude-code](https://claude.com/claude-code)) Sign in with your Claude plan;
  no separate API key is needed.

Run the built-in preflight to confirm the toolchain is ready:

```bash
node bin/doctor.mjs
```

It prints a PASS / FAIL / WARN / INFO checklist (Node, Python, Chrome, the Playwright browser,
your profile, your rules file, your resume) with a one-line fix for anything missing, and exits
non-zero if a required check fails. Re-run it any time something feels off.

---

## 2. One-time setup

Do this once. From the project root:

```bash
# 1. Install dependencies
npm install
npx playwright install chromium        # bundled Chromium — used ONLY to render your resume PDF

# 2. Generate your config interactively
npm run init
```

`npm run init` asks a short set of questions (name, email, location, target roles, sponsorship)
and writes a complete, ready-to-edit project state: `config/profile.yaml` seeded from your
answers, `config/rules.json` generated from it, empty `config/qa-bank.json` and
`config/queue.yaml`, a starter `config/companies.json`, a `tracker.csv` header, and a tailored
`CLAUDE.md` (the agent's operating manual).

```bash
# 3. Complete your profile honestly
#    Open config/profile.yaml and fill in everything the wizard didn't ask:
#    full address, honest skill levels, demographics (all optional), and the essay answers.
#    See config/profile.example.yaml for the fully-commented schema.

# 4. Put your base resume where the profile points
#    Default path: applications/_resumes/resume-base.md  (Markdown or HTML; see
#    config/resume-base.example.md for a starter). This is your master resume; the agent copies
#    it per job and lightly retunes the summary/lead bullet, never inventing anything.

# 5. Regenerate rules after ANY profile edit
npm run build-rules                    # config/profile.yaml -> config/rules.json

# 6. Tell the engine which companies to sweep
#    Edit config/companies.json (a plain data file — grow it freely). Each value is the company's
#    slug on that ATS, i.e. the part of its careers-page URL. See config/companies.example.json.
```

A note on the two profile situations the engine handles out of the box:

- **You don't need sponsorship** (US citizen / permanent resident): it answers work-authorization
  questions Yes and sponsorship-needed questions No.
- **You need sponsorship** (e.g. an H-1B transfer): it answers "authorized *without* sponsorship?"
  truthfully No, declares your visa type, and automatically *skips* roles that explicitly won't
  sponsor — because applying to those is futile, not because of any dishonesty.

Both are driven entirely by the `work_authorization` block in your profile. Nothing is hardcoded.

---

## 3. Start the browser (local laptop)

The form-filling runs in a real, headed Chrome window that Playwright attaches to over CDP.
Launch it once and leave it open:

```bash
bash scripts/start-chrome.sh           # opens Chrome on CDP port 9222 with a persistent profile
```

Then, in that window, **log in once** to LinkedIn and any company SSO you expect to need. The
cookies persist in the profile dir (`~/.auto-apply-chrome`), so automated runs stay logged in and
look like a normal user.

Attach Claude's browser tool to it:

```bash
playwright-cli attach --cdp http://localhost:9222
```

The connection can drop between runs — just re-attach; it's cheap and idempotent. `start-chrome.sh`
is the default local path. (For a headless server with no display, the README covers
`bash scripts/vps-up.sh`, which brings up a virtual display + real Chrome instead. You don't need
that on a laptop.)

---

## 4. Discover jobs

Fill the queue with today's matching postings:

```bash
bash scripts/discover-daily.sh
```

This sweeps every company in `config/companies.json` across Greenhouse, Lever, Ashby,
SmartRecruiters, and Workable (via their public JSON endpoints), keeps only roles that match your
`search.target_roles` and `search.target_locations`, dedupes against what you've already done, and
merges the new ones into `config/queue.yaml`. It prints the READY count at the end. Dedup is
automatic and re-running is safe — what lands as `ready` is effectively just the new postings.

**Growing the net (optional).** When your curated company list feels small:

- `node src/sync-jobhive.mjs` pulls validated, currently-live board slugs from the public jobhive
  project into an optional `config/companies-universe.json`. The next discovery sweep rotates
  through that universe and *promotes* any company that yields an in-scope role into your curated
  `companies.json`. (See `config/companies-universe.example.json` for the shape.)
- `npm run jobhive` (i.e. `python3 src/discover-jobhive.py && CANDS=/tmp/cands-jobhive.json python3
  src/build-queue.py`) queries jobhive's large pre-scraped dataset directly — the easiest way to
  surface SmartRecruiters/Workable roles. Needs the `duckdb` Python module (`pip install duckdb`).
  (The `CANDS=` env is required: discover-jobhive.py writes `/tmp/cands-jobhive.json`, which
  build-queue.py must be pointed at.)
- `node src/harvest-tokens.mjs --extract <file>` mines board slugs out of a saved web-search
  results page. Search e.g. `site:job-boards.greenhouse.io "<your role>" (<your city> OR remote)`
  (and the lever/ashby variants), save the page, then point harvest-tokens at it to add the slugs.

None of these are required to get started — `discover-daily.sh` over your own `companies.json` is
enough for a first run.

---

## 5. Apply

With the browser up and the queue filled, you have three ways to work it.

**A) Interactive, watched (recommended for your first run).** Open Claude Code in this directory
and run the apply command:

```
/apply
```

Or in plain English: *"Read CLAUDE.md and apply to the ready jobs in config/queue.yaml."* For each
job Claude runs the pre-flight (`plan-apply.mjs`), answers any unknown screening questions
truthfully from your profile, lightly tailors the resume and renders the PDF, fills the whole form
in one pass, verifies with the probe, submits on the employer's ATS, and logs a row to
`tracker.csv`. Watch the first few in the Chrome window to build confidence.

To calibrate before letting it submit, set the environment variable `REVIEW_ONLY=1` for the
session — it fills each form and stops without submitting, so you can eyeball the result.

**B) Unattended, full loop.** One command runs discover -> plan -> apply -> review as a sequence
of disposable Claude sessions:

```bash
bash scripts/daily-orchestrate.sh          # default target N=20 jobs
N=5 bash scripts/daily-orchestrate.sh       # cap at 5 (good for a first unattended run)
DRY=1 bash scripts/daily-orchestrate.sh     # print the plan, spawn nothing
```

This routes a capable model to the two judgment seams (planning, review) and a fast model to the
volume (applying). It needs the `claude` CLI and `tmux` on your PATH. For a scheduled nightly run,
`bash scripts/run-nightly.sh` wraps it with cron-friendly PATH and logging.

**C) Unattended, volume only.** To just drain the ready pool in batches without the plan/review
bookends:

```bash
bash scripts/batch-loop.sh                  # 6 jobs per session until the queue is empty
N=20 bash scripts/batch-loop.sh             # stop after ~20 jobs
```

There is no fixed daily cap by default — the engine spaces out repeated requests to the same
employer and otherwise scales to however many genuinely-fitting roles exist. Quality stays
constant: every application is truthful and tailored regardless of volume.

---

## 6. Review the outcomes

After a run, check what went out:

- **`tracker.csv`** — one row per job: date, company, role, url, ATS, resume file, status,
  screenshot, notes, and a trailing `followup_status` (filled in later by the outcome scanner —
  leave it empty when a row is written). Statuses are `SUBMITTED`, `FILLED-PENDING-SUBMIT`,
  `SKIPPED-POOR-FIT`, `SKIPPED-NO-SPONSORSHIP`, `skipped-needs-login`, `SKIPPED-CAPTCHA`,
  `SKIPPED-EMAIL-GATE`, `CLOSED-NOT-SUBMITTED`.
- **`applications/<company>/`** — the tailored resume PDF and the audit screenshot for each job.

To have Claude audit a run for you — catching any wrong auto-answer or over-eager skip and fixing
it at the source (the answer bank / rules) — use the review command in Claude Code:

```
/day-review
```

The unattended orchestrator (option B above) already runs this review step automatically as its
final stage.

**Outcome tracking (optional).** Once you've configured `config/email-imap.json` (same inbox the
email gate uses), `npm run followups` (or `python3 src/scan-followups.py`) polls that inbox,
*conservatively* classifies employer replies — interview, online assessment, offer, rejection, or
ghosted — matches them to your `SUBMITTED` rows by company, and writes the trailing
`followup_status` column in `tracker.csv`. It prints a plain digest to stdout (no notifier wired
in), is idempotent, and supports `--dry-run`. Run it by hand whenever, or from a daily cron:
`0 14 * * * cd /path/to/auto-apply && python3 src/scan-followups.py >> followups.log 2>&1`.

**Email-verification gates (optional).** Some ATSes (e.g. Greenhouse) email a short code mid-apply.
If you add `config/email-imap.json` with read credentials for your apply inbox, the engine can
clear those gates automatically — it polls for the code with
`node src/check-email-code.mjs <company> --wait --code-only` and fills it in. Without that file,
those jobs are simply marked `SKIPPED-EMAIL-GATE` and skipped.

---

## 7. The pre-answer / self-improvement loop

The engine gets cheaper and smarter the more you run it, because answers are learned once and
reused:

- A new screening question with a reusable truthful answer (work authorization, years of
  experience, a demographic) is banked into `config/qa-bank.json` so the pre-flight resolves it
  next time without asking.
- An answer that should change *everywhere* (a skill, a demographic, an essay) goes in
  `config/profile.yaml`; re-run `npm run build-rules` to regenerate `config/rules.json`. Never edit
  the generated `rules.json` by hand.

You can also run the planning pass on its own, ahead of applying, with the `/pre-answer` command in
Claude Code — it resolves the day's screening questions into the answer bank and skips gated jobs,
so the apply step has nothing to guess.

---

## 8. Responsible use

This tool submits real applications under your name. Use it the way you'd want a careful assistant
to:

- **Keep `config/profile.yaml` truthful.** Every typed value comes from it. Honesty here is the
  whole design.
- **Apply only to roles you'd actually take.** Volume comes from casting a wide net over genuinely
  fitting roles, never from lowering the bar.
- **Answer sponsorship questions truthfully, always.** At visa-friendly employers a truthful Yes is
  not a disqualifier; it's what makes a transfer possible. Never answer No just to clear a filter.
- **Submit on the employer's own ATS, never via LinkedIn/Indeed automation** — their terms forbid
  it, and the engine doesn't do it.
- **No CAPTCHA-solving, no defeating login walls.** Those jobs are skipped and logged, not forced.

Respect each site's terms and the spirit of a real application.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `playwright-cli` not found | Install it: `npm install -g @playwright/cli@latest`; confirm with `which playwright-cli`. |
| Can't attach to Chrome | Make sure `bash scripts/start-chrome.sh` is running (CDP on 9222), then re-attach. The connection drops between runs; re-attaching is normal. |
| `npm run doctor` / `node bin/doctor.mjs` shows FAIL | Follow the one-line fix it prints next to each failed check (missing Node/Python/Chrome, no profile, stale rules). |
| `config/rules.json (stale)` warning | You edited the profile but didn't regenerate. Run `npm run build-rules`. |
| "resume file not found" / blank PDF | Make sure your resume exists at the `resume.base` path in the profile, and that you ran `npx playwright install chromium` (the PDF renderer needs it). |
| Apply page wants an account | Login wall — logged as `skipped-needs-login` and skipped. Apply by hand if you want that one. |
| A hard CAPTCHA / hCaptcha blocks | Logged `SKIPPED-CAPTCHA`. The engine never solves CAPTCHAs; do that job manually if you care about it. |
| Email-verification code asked for | Add `config/email-imap.json` (see step 6) to auto-clear it; otherwise it's a `SKIPPED-EMAIL-GATE`. |
| A field silently didn't fill | The filler batches every field into one pass for exactly this reason; re-run the apply step on that job and let the probe re-verify. |
| Discovery finds nothing | Your `companies.json` may be empty/too small, or `search.target_roles` / `target_locations` too narrow. Grow the company list (step 4) and double-check the search block. |
| Unattended run never starts | `scripts/daily-orchestrate.sh` and `batch-loop.sh` need the `claude` CLI and `tmux` on your PATH. |

---

## Where to go next

- **[README.md](README.md)** — the architecture, the pipeline diagram, and the profile model.
- **`config/profile.example.yaml`** — every field, fully commented. Your profile is the one file
  you maintain.
- **`CLAUDE.md`** — the agent's operating manual (generated for you by `npm run init`). It's what
  Claude reads at the start of every cycle.

---
description: Pre-flight — truthfully resolve the day's screening questions into qa-bank/rules and skip gated jobs, so the apply worker just executes
argument-hint: "[max jobs to pre-answer, default 20]"
---
You are the decision layer for the auto-apply pipeline. Your ONLY job is the truth-critical
judgment: resolve screening questions truthfully and up front so the downstream apply worker has
nothing to guess. **You never open a browser and you never submit anything.**

Read `CLAUDE.md` and `config/profile.yaml` once — that is the ground truth. Never invent skills,
employers, dates, or metrics.

Process up to **N = $ARGUMENTS** (default 20) ready jobs:

1. Pull the batch: `node src/next-jobs.mjs <N>` (compact JSON, status:ready only).
2. For EACH job run the no-browser pre-flight: `node src/plan-apply.mjs --url <apply-url>`
   - **exit 2** (a skip-gate fired, e.g. "authorized WITHOUT sponsorship" when the profile needs
     sponsorship) -> this is a truthful SKIP. Set it with
     `node src/mark-status.mjs --url <url> --status <S>` using the SKIPPED-* reason that matches the
     `GATE[...]` line (sponsorship-exclusion -> `SKIPPED-NO-SPONSORSHIP`). Move on — do not
     pre-answer it.
   - **exit 3** (form definition not fetchable) -> leave it for the worker's in-browser probe;
     don't pre-answer.
   - **exit 0** -> read the `? (REQUIRED) <question> :: opt1 | opt2 | ...` unknown lines.
3. For each UNKNOWN that is a **reusable factual screening question** — work authorization,
   sponsorship, citizenship, current location/state, years of experience, highest degree, start
   date / notice, EEO-demographics, security/export-control, a fixed truthful salary expectation —
   pick the truthful answer from `config/profile.yaml` and bank it so plan-apply resolves it next
   time:
   - reusable -> append `{q, option|value, src}` to `config/qa-bank.json` (exact question text + the
     EXACT option label as printed by plan-apply + the `profile.yaml` field it came from).
   - recurring PHRASING (varies by company) -> if it's a general answer that should apply
     everywhere, edit the relevant field in `config/profile.yaml` and re-run `npm run build-rules`
     to regenerate `config/rules.json` (never hand-edit the generated rules.json). Respect rule
     order: citizenship before US-residence; the "without sponsorship" gate before "authorized to
     work".
4. **Only bank answers you can source truthfully and unambiguously from config/profile.yaml.** If a
   question needs data the profile doesn't have (e.g. a street address it omits, a metric it lacks)
   or asks for experience the profile doesn't support (a certification it doesn't list, more years
   than `experience.years_total`):
   - if it's a hard gate -> `mark-status ... --status SKIPPED-POOR-FIT` with the reason.
   - otherwise -> leave it UNKNOWN. Do NOT guess. The worker handles or skips it per CLAUDE.md.
5. Do NOT write job-specific essays (why-us, "describe a time...") here — leave those for the worker.

**SCOPE** (authoritative = `config/profile.yaml`'s `search` block): in-scope titles are
`search.target_roles`; skip ONLY titles matching `search.exclude_titles_containing`. A title is
never a valid skip reason on its own.

When finished, write the sentinel `/tmp/auto-apply-orch/plan.done` as JSON
`{pre_answered:<n>, banked:<n>, skipped:[{url,reason}], rules_added:[short notes]}` and STOP.
End with a one-line tally (banked / skipped / left-unknown).

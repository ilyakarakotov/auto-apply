---
description: Post-run audit — review what the apply worker just did and fix wrong rules at the source
argument-hint: "(none)"
---
You are the oversight layer for the auto-apply pipeline. The apply worker just finished a run.
Audit it, correct any systemic mistake at its source so it can't recur, and report a short digest.
Read `CLAUDE.md` and `config/profile.yaml` once for the truth baseline.

1. **Scope this run's rows.** Read the integer in `/tmp/auto-apply-orch/tracker-mark` (the
   tracker.csv line count captured just before the apply step) and review only `tracker.csv` rows
   AFTER that line. If that file is missing, review rows whose date is today or yesterday. Also read
   `/tmp/auto-apply-orch/plan.done` (the pre-flight's skips/banks) and
   `/tmp/auto-apply-orch/apply.done` (the worker's own submitted/skipped tally) if present.
2. **SUBMITTED rows** — sanity-check the `notes` for truthfulness red flags: an invented
   skill/metric, a work-authorization or sponsorship answer that contradicts
   `config/profile.yaml`'s `work_authorization` block, or an out-of-scope location (not in
   `search.target_locations` and not US-remote). Open `applications/<co>/` for 2-3 only if something
   looks off.
3. **SKIPPED-\* rows** — verify each skip reason is legitimate. Watch hardest for **over-filtering**:
   an in-scope role (its title matches `search.target_roles`) skipped as POOR-FIT is a BUG — a title
   is never a valid skip on its own; only a title matching `search.exclude_titles_containing`, or a
   real gate (a required qualification the profile lacks, a missing required field with no truthful
   answer, no truthful sponsorship answer) is a legitimate skip.
   **VERIFY falsifiable technical claims before repeating them.** A worker's skip reason can be a
   confident GUESS (e.g. blaming a captcha failure on "endpoint blocked by CSP" when the endpoint
   actually returns 200). So when a skip reason asserts something checkable — an endpoint is
   unreachable/blocked, a gate is "systemic", an ATS is "fully blocked" — spend one `curl`/check to
   confirm it, and in the digest label any claim you couldn't verify as "unconfirmed: ..." rather
   than stating it as fact.
4. **Fix at the source — but stay in your lane.** You may ONLY auto-edit these, and nothing else:
   - `config/rules.json` / `config/qa-bank.json` — to correct a wrong auto-answer or bad skip
     pattern. (If the wrong answer should change everywhere, edit `config/profile.yaml` and re-run
     `npm run build-rules` instead of hand-editing the generated rules.json.)
   - `node src/mark-status.mjs --url <url> --status ready` — to un-skip a good job that was wrongly
     skipped.

   **Do NOT, on your own, modify any code (`src/*.py`, `src/*.mjs`, `scripts/*.sh`), install
   packages (`pip`/`npm`), patch the pipeline, or change config beyond the answer-bank files (and
   the profile-driven `build-rules` path) above.** If you discover an infrastructure/code bug (a
   broken discovery source, a 403, a missing dependency, a crashing script), **FLAG it** — put a
   clear, specific description in the digest (what's broken, where, your proposed fix) and leave it
   for a human. Code changes stay in human hands; a silent autonomous patch on a daily cron is a
   risk even when correct.
5. **Report.** Print a concise digest: submitted count, skipped grouped by reason, anything you
   fixed, and ANYTHING that needs a human eye (a recurring gate, a suspicious answer). Keep it short
   and skimmable; a clean run can be one line. Don't claim a submit/skip count you didn't verify
   against the `apply.done` sentinel plus the new tracker rows.

Write the sentinel `/tmp/auto-apply-orch/review.done` as JSON
`{submitted:<n>, skipped:<n>, fixed:[short notes], flags:[anything for the human]}` and STOP.

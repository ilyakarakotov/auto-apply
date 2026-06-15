---
description: Discover and apply to well-fitting roles (truthful, no-login ATS), submitting and logging each
argument-hint: "[number of jobs, default = exhaust the ready pool]"
---
Read CLAUDE.md once, then run a full apply cycle.

STEP 1 — Refresh the queue with today's new jobs (skip only if $ARGUMENTS is a small number and
the queue already has that many ready):
```
bash scripts/discover-daily.sh
```

STEP 2 — Apply to the ready jobs ONE AT A TIME until the pool is exhausted (or until $ARGUMENTS
jobs are done if a number was given). Work in small batches so context stays small:
```
node src/next-jobs.mjs 6        # pull the next 6 ready jobs
```
For EACH job, follow CLAUDE.md's pipeline exactly: `plan-apply.mjs` pre-flight (skip on exit 2) ->
answer unknowns from config/profile.yaml (bank reusable ones in config/qa-bank.json) -> light
tailor + PDF -> `make-filler.mjs --plan` -> one `run-code` fill -> `probe-form.js` verify ->
targeted fixes -> mark FILLED-PENDING-SUBMIT -> submit -> confirm -> mark SUBMITTED + log to
tracker.csv. Re-run `next-jobs.mjs 6` and repeat until it returns 0.

RULES (full detail in CLAUDE.md): truth only from config/profile.yaml; **scope = profile, not your
own judgment** — in-scope titles are `search.target_roles` and the only title-based skip is
`search.exclude_titles_containing` (discovery already drops those), so a title alone is NEVER a
valid skip reason during apply; sponsorship follows the profile's `work_authorization` block;
location scope = `search.target_locations` (plus US-remote if `accept_remote_us`); fully autonomous
— never ask, skip with a logged reason instead. Default to ONE session at a time; the queue is the
durable state, so a single looping session drains it fine.

End with a tally: submitted / skipped (by reason), plus any new config/rules.json or
config/qa-bank.json entries.

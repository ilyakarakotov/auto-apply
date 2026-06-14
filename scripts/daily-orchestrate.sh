#!/usr/bin/env bash
# Daily auto-apply orchestrator — a capable model decides, a fast model applies, then a capable
# model reviews. Pure-bash glue (no LLM tokens spent on sequencing) that runs three model-routed,
# DISPOSABLE Claude Code sessions in order over the durable config/queue.yaml + tracker.csv:
#
#   1. discover           bash, no LLM         refresh the queue with the day's new jobs
#   2. PLAN  (capable)    short session        truthfully bank screening answers + skip gated jobs
#   3. APPLY (fast)       longer session       fill + submit using the now-resolved plans
#   4. REVIEW (capable)   short session        audit the run, fix bad rules, print a digest
#
# The capable model only runs at the two judgment seams (cheap, compact context); the fast model
# does the volume. Each session writes a sentinel file when done; we poll for it, then kill the
# session (disposable-worker model — all real state lives in the queue/tracker, so killing is
# lossless). Schedule it from cron, or run by hand:
#   bash scripts/daily-orchestrate.sh            # full run, default target N=20
#   N=5 bash scripts/daily-orchestrate.sh         # cap at 5 jobs (good for a first watched run)
#   DRY=1 bash scripts/daily-orchestrate.sh       # print the plan + spawn NOTHING
#
# Requires the `claude` CLI on PATH and a browser stack (scripts/vps-up.sh). Models are routed
# via env: CAPABLE_MODEL (default opus) and FAST_MODEL (default sonnet).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO="$PWD"

N="${N:-20}"                          # daily target — bounds quota use AND blast radius
DRY="${DRY:-0}"
ORCH=/tmp/auto-apply-orch
PLAN_CEIL="${PLAN_CEIL:-1200}"        # plan ceiling   (20 min)
APPLY_CEIL="${APPLY_CEIL:-3600}"      # apply ceiling   (60 min)
REVIEW_CEIL="${REVIEW_CEIL:-900}"     # review ceiling  (15 min)
CAPABLE="${CAPABLE_MODEL:-opus}"
FAST="${FAST_MODEL:-sonnet}"

# Pinned rules for the apply session (a compaction can't erode these). Everything truth- and
# scope-related comes from config/profile.yaml — nothing is hardcoded to a person or place.
# NO double-quotes inside — the tmux command string wraps this in escaped quotes.
PINNED="Truth only from config/profile.yaml — never invent skills, employers, dates, or metrics. Answer work-authorization and sponsorship questions exactly per the profile's work_authorization block. Location scope = the profile's search.target_locations (and US-remote if accept_remote_us). Submit only on the employer's own ATS, never via LinkedIn/Indeed. Set queue status only via 'node src/mark-status.mjs'; only ever work status:ready jobs. On any hard gate (image/audio CAPTCHA, login wall) do NOT solve it and do NOT keep the tab open — mark SKIPPED-* and move on. Fully autonomous: never ask a question, never wait for input — make a decision and skip with a logged reason instead."

log(){ echo "[orch $(date -u +%H:%M:%S)] $*" >&2; }

mkdir -p "$ORCH"
rm -f "$ORCH"/plan.done "$ORCH"/apply.done "$ORCH"/review.done

# ---- 1. discover (no LLM) ----
log "browser up + discover"
if [ "$DRY" = 0 ]; then
  bash scripts/vps-up.sh >"$ORCH/vps.log" 2>&1 || log "WARN vps-up returned nonzero (browser may already be up)"
  if [ "${START_FROM:-}" != "apply" ]; then
    bash scripts/discover-daily.sh >"$ORCH/discover.log" 2>&1 || log "WARN discover-daily returned nonzero"
  else
    log "START_FROM=apply — skipping discover"
  fi
fi
READY=$(node src/next-jobs.mjs 1 2>/dev/null \
        | node -pe 'JSON.parse(require("fs").readFileSync(0)).ready_remaining' 2>/dev/null || echo "?")
log "ready pool after discover: $READY"

# spawn a disposable claude session in tmux, wait for its sentinel, then kill it.
# args: name model ceil_secs sentinel_path seed_prompt [pin]
run_session(){
  local name="$1" model="$2" ceil="$3" sentinel="$4" seed="$5" pin="${6:-}"
  tmux kill-session -t "$name" 2>/dev/null
  if [ "$DRY" = 1 ]; then
    log "DRY would spawn: $name [$model]${pin:+ +pinned} :: ${seed:0:80}..."
    : >"$sentinel"; return 0
  fi
  local extra=""
  [ -n "$pin" ] && extra="--append-system-prompt \"$PINNED\""
  # --permission-mode auto: classifier-gated (NOT bypass) — safe ops auto-approve, dangerous ones
  # are denied and the agent adapts (headless-safe, never hangs). Pre-approve the apply hot path
  # (playwright-cli run-code, node *) in .claude/settings.local.json to cut prompts.
  local cmd="cd '$REPO' && claude --model $model --permission-mode auto $extra \"$seed\""
  log "spawn $name [$model] (ceiling ${ceil}s)"
  tmux new-session -d -s "$name" "$cmd"
  local waited=0
  while [ ! -f "$sentinel" ] && [ "$waited" -lt "$ceil" ]; do sleep 10; waited=$((waited+10)); done
  if [ -f "$sentinel" ]; then
    log "$name finished in ${waited}s"
  else
    log "$name TIMEOUT after ${ceil}s — capturing last lines"
    tmux capture-pane -t "$name" -p -S -30 >>"$ORCH/$name.stuck.log" 2>/dev/null || true
  fi
  tmux kill-session -t "$name" 2>/dev/null
}

# ---- 2. PLAN: truthful screening resolution (no browser, no submit) ----
if [ "${START_FROM:-}" != "apply" ]; then
  PLAN_PROMPT="Read CLAUDE.md once. For up to $N ready jobs (use 'node src/next-jobs.mjs $N'), run 'node src/plan-apply.mjs --url <apply-url>' on each. If plan-apply exits 2 (a gate), set the queue status accordingly via 'node src/mark-status.mjs' and move on. For each UNKNOWN question, answer it truthfully from config/profile.yaml and append a {q, value|option, src} entry to config/qa-bank.json (reusable answers only). Do NOT open a browser and do NOT submit anything. When done, write $ORCH/plan.done with a one-line summary and stop."
  run_session orch-plan "$CAPABLE" "$PLAN_CEIL" "$ORCH/plan.done" "$PLAN_PROMPT"
  if [ "${STOP_AFTER:-}" = "plan" ]; then log "STOP_AFTER=plan — halting before apply"; exit 0; fi
fi

# mark the tracker line BEFORE the apply step so review covers exactly this run's rows
wc -l < tracker.csv > "$ORCH/tracker-mark" 2>/dev/null || echo 0 > "$ORCH/tracker-mark"

# ---- 3. APPLY: discovery + planning already done; just execute ----
APPLY_PROMPT="Read CLAUDE.md once. Discovery and planning are ALREADY done by the orchestrator — do NOT run discover-daily. Apply to up to $N ready jobs, working 6 at a time via 'node src/next-jobs.mjs 6', following CLAUDE.md's pipeline exactly for each: plan-apply.mjs (skip on exit 2) -> make-filler --plan -> one run-code fill -> probe-form verify -> mark FILLED-PENDING-SUBMIT -> submit -> confirm -> mark SUBMITTED and append one row to tracker.csv (leave the trailing followup_status column empty). Most screening questions are already resolved in qa-bank.json/rules.json, so mostly just execute; only handle genuinely new per-job fields. Stop once you have processed $N jobs or next-jobs returns 0. Then write $ORCH/apply.done as JSON {submitted:[urls], skipped:[{url,reason}]} and stop."
run_session orch-apply "$FAST" "$APPLY_CEIL" "$ORCH/apply.done" "$APPLY_PROMPT" pin
if [ "${STOP_AFTER:-}" = "apply" ]; then log "STOP_AFTER=apply — halting before review"; exit 0; fi

# ---- 4. REVIEW: audit + fix rules + digest ----
REVIEW_PROMPT="Read CLAUDE.md once. Audit ONLY this run's new tracker.csv rows (those added since the run started). For each, sanity-check that the screening answers were truthful per config/profile.yaml; if you find a wrong auto-answer, fix the matching entry in config/qa-bank.json (and note it). Then print a short digest: counts of submitted vs skipped (by reason) and any qa-bank.json entries changed. Write $ORCH/review.done with the digest and stop."
run_session orch-review "$CAPABLE" "$REVIEW_CEIL" "$ORCH/review.done" "$REVIEW_PROMPT"

log "orchestration complete (ready pool was $READY, target N=$N)"

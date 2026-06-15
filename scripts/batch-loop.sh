#!/usr/bin/env bash
# Drain the ready pool in batches: spawn one DISPOSABLE Claude Code apply session per
# batch of BATCH jobs, wait for its sentinel, kill it, repeat — until the queue is empty
# or a target N is reached. Same disposable-worker model as scripts/daily-orchestrate.sh
# (all durable state lives in config/queue.yaml + tracker.csv, so killing a session is
# lossless). This is the volume loop; daily-orchestrate.sh wraps plan/apply/review around it.
# Everything truth- and scope-related comes from config/profile.yaml — nothing is hardcoded
# to a person or place.
#
#   bash scripts/batch-loop.sh            # drain the whole ready pool, 6 jobs/batch
#   N=20 bash scripts/batch-loop.sh        # stop after ~20 jobs submitted+skipped
#   BATCH=4 bash scripts/batch-loop.sh     # 4 jobs per session
#   DRY=1 bash scripts/batch-loop.sh       # print what each batch would do, spawn NOTHING
#
# Requires the `claude` CLI on PATH and a browser stack already up (scripts/vps-up.sh).
# Model is routed via FAST_MODEL (default sonnet).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO="$PWD"

BATCH="${BATCH:-6}"                    # jobs handed to each session
N="${N:-0}"                           # overall target (0 = drain the whole pool)
DRY="${DRY:-0}"
BATCH_CEIL="${BATCH_CEIL:-3600}"      # per-batch ceiling (60 min)
MAX_BATCHES="${MAX_BATCHES:-50}"      # hard safety stop on the outer loop
FAST="${FAST_MODEL:-sonnet}"
ORCH=/tmp/auto-apply-batch

# Pinned rules the apply session can't erode through a compaction. NO double-quotes inside —
# the tmux command string wraps this in escaped quotes.
PINNED="Truth only from config/profile.yaml — never invent skills, employers, dates, or metrics. Answer work-authorization and sponsorship questions exactly per the profile's work_authorization block. Location scope = the profile's search.target_locations (and US-remote if accept_remote_us). Submit only on the employer's own ATS, never via LinkedIn/Indeed. Set queue status only via 'node src/mark-status.mjs'; only ever work status:ready jobs. On any hard gate (image/audio CAPTCHA, login wall) do NOT solve it and do NOT keep the tab open — mark SKIPPED-* and move on. Fully autonomous: never ask a question, never wait for input — make a decision and skip with a logged reason instead."

log(){ echo "[batch $(date -u +%H:%M:%S)] $*" >&2; }

# how many jobs are still ready (read-only; safe to call between batches)
ready_count(){
  node src/next-jobs.mjs 1 2>/dev/null \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).ready_remaining' 2>/dev/null \
    || echo 0
}

mkdir -p "$ORCH"

done_total=0
for batch_no in $(seq 1 "$MAX_BATCHES"); do
  # stop conditions
  ready="$(ready_count)"
  if [ "$ready" -eq 0 ]; then log "ready pool drained — done"; break; fi
  if [ "$N" -gt 0 ] && [ "$done_total" -ge "$N" ]; then log "target N=$N reached ($done_total processed)"; break; fi

  # this batch size = min(BATCH, remaining-to-target if N set)
  size="$BATCH"
  if [ "$N" -gt 0 ]; then
    remaining=$((N - done_total))
    [ "$remaining" -lt "$size" ] && size="$remaining"
  fi

  id="$(date +%s)"
  sentinel="$ORCH/batch-$id.done"
  rm -f "$sentinel"

  log "batch $batch_no [$FAST] — up to $size jobs (ready pool: $ready, processed so far: $done_total)"

  SEED="Read CLAUDE.md once. Discovery and planning are handled elsewhere — do NOT run discover-daily. Apply to up to $size ready jobs, pulling work with 'node src/next-jobs.mjs $size', following CLAUDE.md's pipeline exactly for each: plan-apply.mjs (skip on exit 2) -> make-filler --plan -> one run-code fill -> probe-form verify -> mark FILLED-PENDING-SUBMIT -> submit -> confirm -> mark SUBMITTED and append one row to tracker.csv (leave the trailing followup_status column empty). Stop once you have processed $size jobs or next-jobs returns 0. Then write $sentinel as JSON {submitted:[urls], skipped:[{url,reason}]} and stop."

  if [ "$DRY" = 1 ]; then
    log "DRY would spawn batch-$id [$FAST] :: ${SEED:0:90}..."
    done_total=$((done_total + size))
    continue
  fi

  # disposable session in tmux; --permission-mode auto is classifier-gated (NOT bypass):
  # safe ops auto-approve, dangerous ones are denied and the agent adapts (headless-safe).
  # Pre-approve the apply hot path (playwright-cli run-code, node *) in .claude/settings.local.json.
  name="batch-$id"
  tmux kill-session -t "$name" 2>/dev/null
  cmd="cd '$REPO' && claude --model $FAST --permission-mode auto --append-system-prompt \"$PINNED\" \"$SEED\""
  tmux new-session -d -s "$name" "$cmd"

  waited=0
  while [ ! -f "$sentinel" ] && [ "$waited" -lt "$BATCH_CEIL" ]; do sleep 10; waited=$((waited+10)); done
  if [ -f "$sentinel" ]; then
    log "batch $batch_no finished in ${waited}s"
    cat "$sentinel" >&2 2>/dev/null || true
  else
    log "batch $batch_no TIMEOUT after ${BATCH_CEIL}s — capturing last lines"
    tmux capture-pane -t "$name" -p -S -30 >>"$ORCH/$name.stuck.log" 2>/dev/null || true
  fi
  tmux kill-session -t "$name" 2>/dev/null

  done_total=$((done_total + size))
  sleep 5
done

log "all batches complete ($done_total jobs processed across the run)"

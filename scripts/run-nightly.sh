#!/usr/bin/env bash
# Thin cron-friendly nightly wrapper around the daily orchestrator. Sets sane env
# defaults, keeps the machine awake (macOS), logs everything to a timestamped file
# under /tmp/auto-apply-logs, then hands off to scripts/daily-orchestrate.sh (which
# runs discover -> plan -> apply -> review over the durable queue/tracker). Nothing
# personal here — all truth and scope come from config/profile.yaml.
#
#   bash scripts/run-nightly.sh           # full nightly run, logged
#   N=5 bash scripts/run-nightly.sh        # cap at 5 jobs (good for a watched first run)
#
# Cron example (run nightly at 02:00 local; cron has a bare PATH, so we set it below):
#   0 2 * * *  /bin/bash /path/to/auto-apply/scripts/run-nightly.sh >/dev/null 2>&1
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# cron/launchd start with a minimal PATH and no shell profile — make `claude`, node,
# and npm-global bins resolvable. npm prefix -g points at the global bin dir.
export PATH="$(npm prefix -g 2>/dev/null)/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Sane nightly defaults (override via env / the cron line). The orchestrator reads these.
export N="${N:-20}"                           # daily target — bounds quota use AND blast radius
export CAPABLE_MODEL="${CAPABLE_MODEL:-opus}"
export FAST_MODEL="${FAST_MODEL:-sonnet}"

LOG_DIR="${LOG_DIR:-/tmp/auto-apply-logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/nightly-$(date -u +%Y%m%dT%H%M%SZ).log"

# Prevent the Mac from sleeping for the duration of this run (no-op flag elsewhere).
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -s -w $$ &
fi

echo "[nightly $(date -u +%FT%TZ)] start — N=$N capable=$CAPABLE_MODEL fast=$FAST_MODEL log=$LOG"
bash scripts/daily-orchestrate.sh >>"$LOG" 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  echo "[nightly $(date -u +%FT%TZ)] complete — see tracker.csv + applications/ for what went out and what got flagged. Full log: $LOG"
else
  echo "[nightly $(date -u +%FT%TZ)] FAILED (exit $status) — see $LOG"
fi
exit "$status"

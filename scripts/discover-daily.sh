#!/usr/bin/env bash
# ONE command to refresh the queue with the day's new jobs: sweep every board in
# config/companies.json, filter to in-scope (per config/profile.yaml), and MERGE into
# config/queue.yaml. Dedup is automatic — already-seen jobs are never re-added, so what lands
# as `ready` is effectively the new postings. Safe to re-run.
#   bash scripts/discover-daily.sh
set -uo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] live ATS sweep (greenhouse/lever/ashby/smartrecruiters/workable) ..."
# GH_LIGHT keeps Greenhouse payloads small; UNIVERSE_BATCH rotates through the optional
# companies-universe.json (if present). Tune SWEEP_CONCURRENCY for your box/network.
UNIVERSE_BATCH="${UNIVERSE_BATCH:-1500}" GH_LIGHT="${GH_LIGHT:-1}" SWEEP_CONCURRENCY="${SWEEP_CONCURRENCY:-40}" \
  node src/discover.mjs > /tmp/cands.json 2>/tmp/discover.log
tail -1 /tmp/discover.log
python3 src/build-queue.py >/dev/null 2>&1 || { echo "build-queue.py failed:"; python3 src/build-queue.py; exit 1; }

echo "[2/2] done."
node src/next-jobs.mjs 1 2>/dev/null | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); `READY JOBS: ${d.ready_remaining}`' 2>/dev/null \
  || echo "READY JOBS: (run \`node src/next-jobs.mjs\` to see the queue)"

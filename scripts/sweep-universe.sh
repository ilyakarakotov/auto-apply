#!/usr/bin/env bash
# Full, memory-safe pass over the OPTIONAL config/companies-universe.json (a large list of
# UNPROVEN ATS slugs) in resumable shards, then build-queue. Each shard is one discover.mjs run
# with SKIP_CURATED=1 GH_LIGHT=1 (skip the curated lists, fetch tiny Greenhouse payloads) over a
# fixed-size batch; discover.mjs advances config/.universe-cursor.json and PROMOTES any company
# that yields an in-scope role into config/companies.json, so progress is durable shard by shard.
# After every shard, all hits are merged into one candidates file and fed to build-queue.py.
#   bash scripts/sweep-universe.sh                 # full pass, default batch
#   BATCH=800 SWEEP_CONCURRENCY=24 bash scripts/sweep-universe.sh   # override batch/concurrency
set -uo pipefail
cd "$(dirname "$0")/.."

UNIVERSE="config/companies-universe.json"
if [ ! -f "$UNIVERSE" ]; then
  echo "no $UNIVERSE — universe sweep is optional. Populate it first:"
  echo "  node src/sync-jobhive.mjs   (or)   node src/harvest-tokens.mjs --extract <file>"
  echo "  cp config/companies-universe.example.json $UNIVERSE   # to try the tiny example"
  exit 0
fi

BATCH="${BATCH:-800}"
OUT="${OUT:-/tmp/auto-apply-universe}"
CONC="${SWEEP_CONCURRENCY:-24}"
mkdir -p "$OUT"

# shard count = ceil(longest per-ATS list / BATCH); one shard sweeps BATCH slugs per ATS.
MAXLIST=$(node -e "const u=JSON.parse(require('fs').readFileSync('$UNIVERSE','utf8'));const n=k=>Array.isArray(u[k])?u[k].length:0;console.log(Math.max(n('greenhouse'),n('lever'),n('ashby')))")
if [ -z "$MAXLIST" ] || [ "$MAXLIST" -le 0 ]; then echo "universe is empty — nothing to sweep."; exit 0; fi
SHARDS=$(( (MAXLIST + BATCH - 1) / BATCH ))
echo "sweeping universe: $SHARDS shards of $BATCH per ATS (concurrency $CONC)"

for i in $(seq 1 "$SHARDS"); do
  echo "[shard $i/$SHARDS] $(date +%T)"
  SKIP_CURATED=1 GH_LIGHT=1 UNIVERSE_BATCH="$BATCH" SWEEP_CONCURRENCY="$CONC" \
    node src/discover.mjs > "$OUT/shard-$i.json" 2>>"$OUT/sweep.log" \
    || echo "  shard $i failed (continuing)"
done
echo "all shards done -> $OUT/shard-*.json"

# Merge every shard's candidates into one array, then run the in-scope filter + queue merge once.
node -e "
const fs=require('fs');
const dir='$OUT';
const seen=new Set(), out=[];
for(const f of fs.readdirSync(dir)){
  if(!/^shard-\d+\.json\$/.test(f)) continue;
  let arr; try{ arr=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); }catch{ continue; }
  if(!Array.isArray(arr)) continue;
  for(const c of arr){ const k=(c.url||'')+'|'+(c.company||'')+'|'+(c.id||''); if(seen.has(k))continue; seen.add(k); out.push(c); }
}
fs.writeFileSync('/tmp/cands.json', JSON.stringify(out));
console.error('merged '+out.length+' candidates from '+dir);
"
python3 src/build-queue.py >/dev/null 2>&1 || { echo "build-queue.py failed:"; python3 src/build-queue.py; exit 1; }
echo "queue updated. Run \`node src/next-jobs.mjs\` to see ready jobs."

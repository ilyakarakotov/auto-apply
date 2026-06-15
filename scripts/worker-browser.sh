#!/usr/bin/env bash
# Launch ONE fully-isolated headed Chrome for a parallel apply worker so workers never collide:
# its own CDP port (9222+N), its own profile (.auto-apply-chrome-wN), and — on Linux — its own
# Xvfb display (:100+N). No overlap with the shared :99/9222 session (scripts/vps-up.sh) or other
# workers. No VNC (workers run unattended; gated jobs are logged SKIPPED-* and skipped). Idempotent.
#
# DEFAULT is ONE session. Only use parallel workers for a very large ready queue (100+).
#
#   bash scripts/worker-browser.sh <worker-num>    # e.g. 1 -> CDP 9223 / :101 / .auto-apply-chrome-w1
#
# Then each worker attaches to its own browser and uses its own filler:
#   playwright-cli -s=w1 attach --cdp http://localhost:9223
#   playwright-cli -s=w1 run-code --filename /tmp/fill-run-w1.js
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${1:?usage: worker-browser.sh <worker-num>}"
PORT="$((9222 + N))"
# Per-worker profile must NOT inherit a shared CHROME_PROFILE (e.g. one exported by vps-up.sh), or
# every worker would collapse onto one profile and collide. CHROME_BIN may still override the binary.
PROFILE="$HOME/.auto-apply-chrome-w${N}"
RUN=/tmp/auto-apply-logs; mkdir -p "$RUN" "$PROFILE"

# Resolve a Chrome/Chromium binary (CHROME_BIN wins; then the mac .app paths; then PATH names).
find_chrome() {
  for c in "${CHROME_BIN:-}" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    google-chrome-stable google-chrome chromium-browser chromium; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}

up() { curl -s --max-time 3 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; }
wait_up() { for i in $(seq 1 25); do up && return 0; sleep 1; done; return 1; }

if up; then echo "w${N}: Chrome CDP $PORT up"; echo "w${N}: CDP=http://localhost:${PORT}"; exit 0; fi

if [ "$(uname)" = "Darwin" ]; then
  # Local (macOS): each worker gets its own headed window + profile + CDP port. No Xvfb, and no
  # setsid (it is Linux-only and absent on stock macOS) — use nohup to detach.
  CHROME="$(find_chrome)" || { echo "w${N}: no Chrome/Chromium found (set CHROME_BIN)"; exit 1; }
  nohup "$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --window-size=1440,900 --lang=en-US \
    --disable-blink-features=AutomationControlled about:blank \
    >"$RUN/chrome-w${N}.log" 2>&1 &
  wait_up && echo "w${N}: started Chrome CDP $PORT (profile $PROFILE)" || echo "w${N}: Chrome failed to come up — see $RUN/chrome-w${N}.log"
  echo "w${N}: CDP=http://localhost:${PORT}"
else
  # Linux (VPS / CI): isolated Xvfb display + headed google-chrome-stable, same posture as vps-up.sh.
  DISP=":$((100 + N))"
  export DISPLAY="$DISP"
  if ! pgrep -f "Xvfb $DISP" >/dev/null; then
    setsid Xvfb "$DISP" -screen 0 1440x900x24 -nolisten tcp >"$RUN/xvfb-w${N}.log" 2>&1 &
    sleep 1; echo "w${N}: started Xvfb $DISP"; else echo "w${N}: Xvfb $DISP up"; fi
  CDP_PORT="$PORT" CHROME_PROFILE="$PROFILE" DISPLAY="$DISP" \
    setsid bash "$ROOT/scripts/start-chrome-linux.sh" >"$RUN/chrome-w${N}.log" 2>&1 &
  wait_up && echo "w${N}: started Chrome CDP $PORT (profile $PROFILE)" || echo "w${N}: Chrome failed to come up — see $RUN/chrome-w${N}.log"
  echo "w${N}: DISPLAY=$DISP CDP=http://localhost:${PORT}"
fi

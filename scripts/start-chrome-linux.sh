#!/usr/bin/env bash
# Launch headed google-chrome-stable with a CDP port and a persistent profile, on Linux.
# Called by scripts/vps-up.sh. The anti-bot posture here is deliberate — see the note below.
set -euo pipefail
PROFILE="${CHROME_PROFILE:-$HOME/.auto-apply-chrome}"
PORT="${CDP_PORT:-9222}"
export DISPLAY="${DISPLAY:-:99}"
mkdir -p "$PROFILE"
exec google-chrome-stable \
  --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check --window-size=1440,900 \
  --disable-blink-features=AutomationControlled --lang=en-US about:blank
  # ^ AutomationControlled OFF + persistent profile = lower hCaptcha bot-score.
  #   navigator.webdriver is patched per-page by the generated filler (filler.template.js).
  #   Do NOT add --headless or --enable-automation here: both spike the hCaptcha risk score.

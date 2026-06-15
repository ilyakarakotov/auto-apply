#!/usr/bin/env bash
# Launch the ONE real headed Chrome window that Playwright attaches to over CDP, on a
# local laptop with a real display (macOS or Linux). Log into LinkedIn / company SSO once
# here; cookies persist in the profile dir, so automated runs stay logged in and look like
# a normal user. This is the DEFAULT browser path for local runs; scripts/vps-up.sh is the
# headless scale-up (Xvfb + noVNC) for a VPS/CI box without a display.
#   bash scripts/start-chrome.sh
# Then attach Playwright to CDP:  playwright-cli attach --cdp http://localhost:9222
set -euo pipefail
PROFILE="${CHROME_PROFILE:-$HOME/.auto-apply-chrome}"
PORT="${CDP_PORT:-9222}"

# Already up? CDP answering on PORT means a window is live — reuse it, don't double-launch.
if curl -s --max-time 3 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome already up on CDP http://localhost:${PORT} — reusing it."
  echo "Next: playwright-cli attach --cdp http://localhost:${PORT}"
  exit 0
fi

# Resolve the Chrome binary. Honor CHROME_BIN if set; otherwise detect per OS.
find_chrome() {
  if [ -n "${CHROME_BIN:-}" ]; then echo "$CHROME_BIN"; return 0; fi
  case "$(uname -s)" in
    Darwin)
      local mac="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      if [ -x "$mac" ]; then echo "$mac"; return 0; fi
      for c in google-chrome google-chrome-stable chromium; do
        command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
      done ;;
    *)
      for c in google-chrome-stable google-chrome chromium chromium-browser; do
        command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
      done ;;
  esac
  return 1
}

CHROME="$(find_chrome)" || {
  echo "No Chrome binary found. Install Google Chrome, or set CHROME_BIN=/path/to/chrome." >&2
  exit 1
}

mkdir -p "$PROFILE"
echo "Starting Chrome ($CHROME)"
echo "  CDP:     http://localhost:${PORT}"
echo "  profile: $PROFILE"
echo "→ Leave this window open. Log into the sites you'll apply through once."
echo "Next: playwright-cli attach --cdp http://localhost:${PORT}"

# Anti-bot posture (keep it): persistent --user-data-dir + --disable-blink-features=AutomationControlled
# lower the Lever/invisible-hCaptcha risk score. NO --headless and NO --enable-automation — both
# spike the bot score. No Xvfb here: a local laptop has a real display.
exec "$CHROME" \
  --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --window-size=1440,900 \
  --disable-blink-features=AutomationControlled --lang=en-US about:blank

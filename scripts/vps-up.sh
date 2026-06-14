#!/usr/bin/env bash
# Bring up the headed-browser stack on a headless box (VPS / CI): a virtual display, a real
# headed google-chrome-stable over CDP, and an optional noVNC view so a human can watch / take
# over. Idempotent — safe to run repeatedly; it only starts what isn't already up.
#   bash scripts/vps-up.sh
# Then attach Playwright to CDP:  playwright-cli attach --cdp http://localhost:9222
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DISPLAY_NUM="${DISPLAY_NUM:-99}"; DISP=":${DISPLAY_NUM}"
CDP_PORT="${CDP_PORT:-9222}"; VNC_PORT="${VNC_PORT:-5900}"; NOVNC_PORT="${NOVNC_PORT:-6080}"
export CHROME_PROFILE="${CHROME_PROFILE:-$HOME/.auto-apply-chrome}"
RUN=/tmp/auto-apply-logs; mkdir -p "$RUN"
export DISPLAY="$DISP"
WS="$(command -v websockify || echo 'python3 -m websockify')"

# 1) virtual display
if ! pgrep -f "Xvfb $DISP" >/dev/null; then
  setsid Xvfb "$DISP" -screen 0 1440x900x24 -nolisten tcp >"$RUN/xvfb.log" 2>&1 &
  sleep 1; echo "started Xvfb $DISP"; else echo "Xvfb up"; fi

# 2) headed Chrome with CDP, on the virtual display
if ! curl -s --max-time 3 "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  CDP_PORT="$CDP_PORT" DISPLAY="$DISP" setsid bash "$ROOT/scripts/start-chrome-linux.sh" >"$RUN/chrome.log" 2>&1 &
  for i in $(seq 1 25); do curl -s --max-time 2 "http://localhost:${CDP_PORT}/json/version" >/dev/null && break; sleep 1; done
  echo "started Chrome CDP $CDP_PORT"; else echo "Chrome CDP up"; fi

# 3) x11vnc bound to localhost (optional viewer; skipped if x11vnc isn't installed)
if command -v x11vnc >/dev/null && ! pgrep -f "x11vnc.*rfbport ${VNC_PORT}" >/dev/null; then
  x11vnc -display "$DISP" -rfbport "$VNC_PORT" -localhost -forever -shared -nopw -bg -o "$RUN/x11vnc.log" 2>/dev/null
  echo "started x11vnc localhost:${VNC_PORT}"; else echo "x11vnc up or not installed"; fi

# 4) noVNC (websockify) bound to localhost (optional)
WEBROOT=/usr/share/novnc; [ -d "$WEBROOT" ] || WEBROOT=/usr/share/webapps/novnc
if [ -d "$WEBROOT" ] && ! pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null; then
  setsid $WS --web="$WEBROOT" "127.0.0.1:${NOVNC_PORT}" "localhost:${VNC_PORT}" >"$RUN/novnc.log" 2>&1 &
  echo "started noVNC 127.0.0.1:${NOVNC_PORT}"; else echo "noVNC up or not installed"; fi

echo "--- DISPLAY=$DISP  CDP=http://localhost:${CDP_PORT}  noVNC=http://127.0.0.1:${NOVNC_PORT}/vnc.html"

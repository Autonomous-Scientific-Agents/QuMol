#!/usr/bin/env bash
# Install or update QuMol on an Ubuntu/Debian server and run it as a systemd service.
# Safe to re-run: it pulls the latest code, updates dependencies and restarts the service.
#
#   curl -fsSL https://raw.githubusercontent.com/Autonomous-Scientific-Agents/QuMol/main/deploy/install.sh | bash
#   # or, from a clone:  bash deploy/install.sh
#
# Options (environment variables):
#   APP_DIR   where the code lives            (default: ~/qumol)
#   PORT      local port uvicorn listens on    (default: 8010, bound to 127.0.0.1 only)
#   METHOD    energy method: toyff | uma       (default: toyff)
#   TAILSCALE serve  = HTTPS on your tailnet only (default)
#             funnel = public HTTPS link anyone can open (friends without Tailscale)
#             off    = don't touch Tailscale
#   TS_PORT   HTTPS port on the tailnet name: 443, 8443 or 10000 (default: 8443,
#             so it won't replace anything you already serve on 443)
set -euo pipefail
TAILSCALE="${TAILSCALE:-serve}"
TS_PORT="${TS_PORT:-8443}"

APP_DIR="${APP_DIR:-$HOME/qumol}"
PORT="${PORT:-8010}"
METHOD="${METHOD:-toyff}"
REPO="${REPO:-https://github.com/Autonomous-Scientific-Agents/QuMol.git}"
RUN_USER="$(id -un)"

echo "==> QuMol → $APP_DIR (port $PORT, method $METHOD, user $RUN_USER)"

if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  echo "==> Installing python3-venv"
  sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
fi

if [ -d "$APP_DIR/.git" ]; then
  echo "==> Updating code"
  git -C "$APP_DIR" pull --ff-only
else
  echo "==> Cloning $REPO"
  git clone "$REPO" "$APP_DIR"
fi

echo "==> Python environment"
[ -x "$APP_DIR/.venv/bin/python" ] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
if [ "$METHOD" = "uma" ]; then
  "$APP_DIR/.venv/bin/pip" install -q ase fairchem-core
fi

mkdir -p "$APP_DIR/data"

echo "==> systemd service"
sudo tee /etc/systemd/system/qumol.service >/dev/null <<EOF
[Unit]
Description=QuMol molecule game server
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=QUMOL_DB=$APP_DIR/data/qumol.db
Environment=QUMOL_METHOD=$METHOD
ExecStart=$APP_DIR/.venv/bin/uvicorn qumol.app:app --host 127.0.0.1 --port $PORT --proxy-headers
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable qumol >/dev/null
sudo systemctl restart qumol

echo "==> Health check"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then echo; ok=1; break; fi
  sleep 1
done
if [ -z "${ok:-}" ]; then
  echo "QuMol did not start. Logs:"; sudo journalctl -u qumol -n 40 --no-pager; exit 1
fi

echo "QuMol is running on 127.0.0.1:$PORT (database: $APP_DIR/data/qumol.db)."

if [ "$TAILSCALE" != "off" ]; then
  if ! command -v tailscale >/dev/null; then
    echo "!! tailscale is not installed; skipping. Install it: https://tailscale.com/download"
  else
    echo "==> Tailscale $TAILSCALE on https port $TS_PORT"
    if sudo tailscale "$TAILSCALE" --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"; then
      DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
      URL="https://${DNS:-<this-machine>.<tailnet>.ts.net}$( [ "$TS_PORT" = 443 ] || echo ":$TS_PORT")/"
      echo
      if [ "$TAILSCALE" = "funnel" ]; then echo "🌍 Public link (share with anyone): $URL"
      else echo "🔒 Tailnet link (devices on your tailnet): $URL"; echo "   For a public link: TAILSCALE=funnel bash $APP_DIR/deploy/install.sh"; fi
      echo "   (the first visit can take a few seconds while Tailscale issues the HTTPS certificate)"
    else
      echo "!! tailscale $TAILSCALE failed. Common fixes:"
      echo "   - enable HTTPS certificates (and Funnel, for public links) in the Tailscale admin console → DNS / Access controls"
      echo "   - older Tailscale versions use: sudo tailscale serve https:$TS_PORT / http://127.0.0.1:$PORT"
    fi
  fi
fi

echo
echo "Update later by re-running this script.  Logs: journalctl -u qumol -f   Tailscale: tailscale serve status"

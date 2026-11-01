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
#   REF       git tag or commit to deploy instead of the latest main (recommended once you tag releases)
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
  git -C "$APP_DIR" fetch --tags -q origin
else
  echo "==> Cloning $REPO"
  git clone -q "$REPO" "$APP_DIR"
fi
if [ -n "${REF:-}" ]; then
  git -C "$APP_DIR" -c advice.detachedHead=false checkout -q "$REF"
else
  git -C "$APP_DIR" checkout -q main && git -C "$APP_DIR" merge -q --ff-only origin/main
fi
echo "    at $(git -C "$APP_DIR" rev-parse --short HEAD)"

echo "==> Python environment"
[ -x "$APP_DIR/.venv/bin/python" ] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
if [ "$METHOD" = "uma" ]; then
  echo "==> UMA (fairchem-core)"
  "$APP_DIR/.venv/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
    || { echo "!! UMA needs Python 3.11 or newer (fairchem-core)"; exit 1; }
  if ! command -v nvidia-smi >/dev/null; then
    # No GPU: the CPU build of PyTorch is far smaller than the default CUDA one.
    "$APP_DIR/.venv/bin/pip" install -q torch --index-url https://download.pytorch.org/whl/cpu
  fi
  "$APP_DIR/.venv/bin/pip" install -q ase fairchem-core
  # The weights are gated on Hugging Face: accept the terms at https://huggingface.co/facebook/UMA,
  # then pass your token (HF_TOKEN=hf_... bash install.sh) or log in once with `hf auth login`.
  TOKEN="${HF_TOKEN:-}"
  [ -z "$TOKEN" ] && [ -f "$HOME/.cache/huggingface/token" ] && TOKEN="$(cat "$HOME/.cache/huggingface/token")"
  if [ -z "$TOKEN" ]; then
    echo "!! No Hugging Face token found. Accept the UMA terms, then re-run with HF_TOKEN=hf_..."; exit 1
  fi
  mkdir -p "$APP_DIR/data" && chmod 700 "$APP_DIR/data"
  umask 077
  printf 'HF_TOKEN=%s\n' "$TOKEN" > "$APP_DIR/data/secrets.env"
  umask 022
fi

echo "==> Front-end libraries (pinned, checksum-verified)"
bash "$APP_DIR/scripts/fetch_vendor.sh"

# Database folder readable only by the service user (it holds login-token hashes).
mkdir -p "$APP_DIR/data/cache"
chmod 700 "$APP_DIR/data"

if [ "$METHOD" = "uma" ]; then MEM_MAX=8G; else MEM_MAX=1500M; fi

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
Environment=HF_HOME=$APP_DIR/data/cache/huggingface
Environment=XDG_CACHE_HOME=$APP_DIR/data/cache
Environment=FAIRCHEM_CACHE_DIR=$APP_DIR/data/cache/fairchem
EnvironmentFile=-$APP_DIR/data/secrets.env
UMask=0077
# Only reachable through Tailscale on this machine; X-Forwarded-For is trusted only from localhost.
ExecStart=$APP_DIR/.venv/bin/uvicorn qumol.app:app --host 127.0.0.1 --port $PORT --proxy-headers --forwarded-allow-ips 127.0.0.1 --no-server-header
Restart=on-failure
RestartSec=3

# Sandboxing: the app sees only its own folder (read-only) and writes only to data/.
# The rest of your home directory (~/.ssh, other projects) is hidden from it.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=$APP_DIR
BindPaths=$APP_DIR/data
ReadWritePaths=$APP_DIR/data
ProtectProc=invisible
ProcSubset=pid
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
MemoryMax=$MEM_MAX
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
TasksMax=256

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
echo "Check the logs show your players' real IPs (rate limits rely on it): journalctl -u qumol | tail
Update later by re-running this script.  Logs: journalctl -u qumol -f   Tailscale: tailscale serve status"

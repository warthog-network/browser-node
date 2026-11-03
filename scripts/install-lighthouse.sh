#!/bin/bash
# Install the lighthouse custodian on THIS machine. Not for the coordinator.
# Run as root on the lighthouse VPS, from a checkout of browser-node:
#   sudo bash scripts/install-lighthouse.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root on the lighthouse VPS" >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "node >= 20 is required" >&2
  exit 1
fi

id lighthouse >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/lighthouse --shell /usr/sbin/nologin lighthouse

install -d -o lighthouse -g lighthouse -m 0700 /var/lib/lighthouse
install -d -o lighthouse -g lighthouse -m 0755 /opt/lighthouse /opt/lighthouse/src /opt/lighthouse/src/lib

install -o lighthouse -g lighthouse -m 0644 "$ROOT/scripts/lighthouse.mjs" /opt/lighthouse/lighthouse.mjs
install -o lighthouse -g lighthouse -m 0644 "$ROOT/src/lib/nodeIdentity.js" /opt/lighthouse/src/lib/nodeIdentity.js
install -o lighthouse -g lighthouse -m 0644 "$ROOT/src/lib/sealedPreshare.js" /opt/lighthouse/src/lib/sealedPreshare.js
install -o lighthouse -g lighthouse -m 0644 "$ROOT/scripts/lighthouse.service" /etc/systemd/system/lighthouse.service

cat > /opt/lighthouse/package.json << 'EOF'
{
  "name": "lighthouse",
  "private": true,
  "type": "module",
  "dependencies": {
    "@noble/curves": "^1.9.7",
    "@noble/hashes": "^1.8.0"
  }
}
EOF
chown lighthouse:lighthouse /opt/lighthouse/package.json

sudo -u lighthouse npm install --prefix /opt/lighthouse --omit=dev

# The script imports ../src from scripts/ in the repo. On the VPS it lives at
# /opt/lighthouse/lighthouse.mjs and the libs are /opt/lighthouse/src/lib.
sed -i 's|../src/lib/|/opt/lighthouse/src/lib/|' /opt/lighthouse/lighthouse.mjs

systemctl daemon-reload
systemctl enable --now lighthouse.service
systemctl --no-pager --full status lighthouse.service | head -20

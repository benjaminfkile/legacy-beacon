#!/usr/bin/env bash
# Installs or updates the legacy beacon as a systemd service on this host
# (legacy-beacon.md 7). Run from a clone of the repository as the user the
# service should run as; it uses sudo for the unit file and systemctl.
#
#   scripts/install-service.sh            build the checkout as it is and (re)start
#   scripts/install-service.sh --pull     first fast-forward to origin/main
#
# The configuration lives only on the host, in /etc/legacy-beacon/legacy-beacon.env
# (root:<user>, mode 0640); the script refuses to start without it.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)"
user="$(id -un)"
node="$(command -v node)"
env_file=/etc/legacy-beacon/legacy-beacon.env
unit=/etc/systemd/system/legacy-beacon.service

cd "$dir"
if [ "${1:-}" = "--pull" ]; then
  git fetch --quiet origin main
  git checkout --quiet main
  git merge --quiet --ff-only origin/main
fi

major="$("$node" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "node 22 or newer required (found $("$node" -v))" >&2; exit 1; }
sudo test -f "$env_file" || { echo "missing $env_file; create it first (legacy-beacon.md 6)" >&2; exit 1; }

npm ci --no-audit --no-fund
npm run build
npm --prefix web ci --no-audit --no-fund
npm --prefix web run build

sed -e "s#@USER@#$user#" -e "s#@DIR@#$dir#" -e "s#@NODE@#$node#" deploy/legacy-beacon.service \
  | sudo tee "$unit" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable legacy-beacon.service >/dev/null
sudo systemctl restart legacy-beacon.service
sleep 2
systemctl --no-pager --lines=0 status legacy-beacon.service | head -5
echo "commit $(git rev-parse --short HEAD)"

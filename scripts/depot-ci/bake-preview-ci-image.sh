#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

pnpm_version="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"
export PNPM_CONFIG_STORE_DIR="${PNPM_CONFIG_STORE_DIR:-/home/runner/.pnpm-store}"

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  echo "error: need root privileges for: $*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command: $1" >&2
    exit 1
  fi
}

echo "==> Preparing pnpm ${pnpm_version}"
require_command node
require_command npm
npm install --global "pnpm@${pnpm_version}"
pnpm config set store-dir "$PNPM_CONFIG_STORE_DIR"
node --version
pnpm --version
echo "pnpm-store=$(pnpm store path)"

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> Baking Node and pnpm onto system PATH"
node_root="$(dirname "$(dirname "$(command -v node)")")"
run_as_root rm -rf /opt/iterate-node
run_as_root cp -a "$node_root" /opt/iterate-node
run_as_root ln -sf /opt/iterate-node/bin/node /usr/local/bin/node
run_as_root ln -sf /opt/iterate-node/bin/npm /usr/local/bin/npm
run_as_root ln -sf /opt/iterate-node/bin/npx /usr/local/bin/npx
run_as_root ln -sf /opt/iterate-node/bin/pnpm /usr/local/bin/pnpm
node --version
pnpm --version

echo "==> Installing Doppler CLI"
curl -sfLS https://cli.doppler.com/install.sh | sh -s -- --no-package-manager
doppler --version

echo "==> Installing preview browser"
pnpm exec playwright install chromium

echo "==> Installing ESP-IDF for Kit Firmware"
scripts/depot-ci/esp-idf.sh install

echo "==> Reporting baked cache size"
echo "pnpm-store=$(pnpm store path)"
du -sh "$(pnpm store path)" || true
du -sh node_modules || true
du -sh /home/runner/.cache/ms-playwright || true
du -sh /home/runner/esp-idf /home/runner/.espressif || true

# Seal only after every setup step succeeds. This receipt travels with the tree.
/usr/local/bin/node scripts/depot-ci/dependencies.mjs seal

#!/usr/bin/env bash
set -euo pipefail

# This script bootstraps the Iterate monorepo for Codex-provided Ubuntu/Debian
# environments so that TypeScript type-checking, linting, formatting, and tests
# succeed. It installs build prerequisites, configures Node.js via nvm using the
# version tracked in .nvmrc, enables the pnpm version defined in package.json,
# installs dependencies, and runs the relevant workspace commands.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

log() {
  printf '\n\033[1;34m>>> %s\033[0m\n' "$1"
}

require_sudo() {
  if [[ "$EUID" -ne 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "This script requires sudo privileges to install system packages." >&2
      echo "Install sudo or run as root and re-run the script." >&2
      exit 1
    fi
  fi
}

log "Updating apt package lists"
require_sudo
sudo apt-get update

log "Installing base dependencies"
sudo apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  pkg-config \
  tar \
  unzip

log "Installing Doppler CLI"
if ! command -v doppler >/dev/null 2>&1; then
  curl -Ls https://cli.doppler.com/install.sh | sudo sh
else
  log "Doppler already installed; skipping"
fi

log "Installing NVM"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

NODE_VERSION="${NODE_VERSION:-}"
if [[ -z "$NODE_VERSION" && -f "$REPO_ROOT/.nvmrc" ]]; then
  NODE_VERSION="$(tr -d '\r\n' < "$REPO_ROOT/.nvmrc")"
fi
NODE_VERSION="${NODE_VERSION:-lts/*}"
log "Using Node.js version $NODE_VERSION"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

log "Configuring pnpm via Corepack"
corepack enable
PNPM_VERSION="$(node -p "require('$REPO_ROOT/package.json').packageManager.split('@')[1]")"
corepack prepare pnpm@"$PNPM_VERSION" --activate

log "Installing workspace dependencies"
cd "$REPO_ROOT"
pnpm install

log "Running pnpm typecheck"
pnpm typecheck

log "Running pnpm lint"
pnpm lint

log "Running pnpm format"
pnpm format

if doppler me >/dev/null 2>&1; then
  log "Running pnpm test"
  pnpm test
else
  log "Skipping pnpm test"
  echo "Doppler authentication is required for 'pnpm test'. Run 'doppler login' and 'doppler setup --project os --config dev_codex'" \
    "before executing 'pnpm test'."
fi

cat <<'INSTRUCTIONS'
-------------------------------------------------------------------
Next steps (manual):
1. Authenticate with Doppler if you haven't already:
     doppler login
     doppler setup   # choose project "os" and config "dev_personal" or "dev_codex"
2. Start the development environment when ready:
     pnpm dev
-------------------------------------------------------------------
INSTRUCTIONS

log "Bootstrap complete"

#!/usr/bin/env bash
set -euo pipefail

# This script bootstraps the Iterate monorepo for local development on Codex-provided
# Ubuntu/Debian systems. It installs Docker (for Postgres and Wrangler containers),
# Doppler, NVM/Node.js, pnpm, and prepares the workspace dependencies. Re-run the script
# whenever you need to pick up toolchain updates; it is safe to execute multiple times.

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
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  build-essential \
  pkg-config \
  unzip \
  tar

log "Ensuring Docker Engine and Compose are installed"
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
      sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker already installed; skipping"
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now docker || true
else
  sudo service docker start || true
fi

if ! id -nG "$USER" | grep -qw docker; then
  log "Adding $USER to docker group (log out/in to apply)"
  sudo usermod -aG docker "$USER"
fi

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
if [[ -z "$NODE_VERSION" ]]; then
  if [[ -f "$REPO_ROOT/.nvmrc" ]]; then
    NODE_VERSION="$(tr -d '\r' < "$REPO_ROOT/.nvmrc" | tr -d '\n')"
  fi
fi
NODE_VERSION="${NODE_VERSION:-v24.4.1}"
log "Using Node.js version $NODE_VERSION"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

log "Enabling pnpm via Corepack"
corepack enable
PNPM_VERSION="$(node -p "require('$REPO_ROOT/package.json').packageManager.split('@')[1]")"
corepack use pnpm@"$PNPM_VERSION"

log "Installing workspace dependencies"
cd "$REPO_ROOT"
pnpm install

log "Starting Postgres via Docker Compose"
docker compose up -d postgres

log "Waiting for Postgres to become ready"
POSTGRES_READY=0
for attempt in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres -d iterate >/dev/null 2>&1; then
    POSTGRES_READY=1
    break
  fi
  sleep 2
done
if [[ "$POSTGRES_READY" -ne 1 ]]; then
  echo "Postgres did not become ready in time; check docker logs" >&2
  exit 1
fi

log "Running database migrations"
pnpm db:migrate

cat <<'INSTRUCTIONS'

-------------------------------------------------------------------
Next steps (manual):
1. Authenticate with Doppler if you haven't already:
     doppler login
     doppler setup   # choose project "os" and config "dev_personal"
2. Configure ngrok if you need Slack/webhook development (see README).
3. Start the development environment:
     pnpm dev
-------------------------------------------------------------------
INSTRUCTIONS

log "Bootstrap complete"

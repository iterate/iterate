#!/bin/bash
set -eo pipefail

# Setup script for async coding agents (Claude Code, Codex, etc.)

NODE_VERSION="${NODE_VERSION:-24.4.1}"
PNPM_VERSION="${PNPM_VERSION:-10.17.1}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-dev}"

echo "Installing Doppler CLI"
# Download directly from GitHub (cli.doppler.com fails in Claude Code web proxy)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
DOPPLER_VERSION=$(curl -fsSL "https://api.github.com/repos/DopplerHQ/cli/releases/latest" | grep -oP '"tag_name":\s*"\K[^"]+')
echo "Installing Doppler v${DOPPLER_VERSION} for ${OS}/${ARCH}"
case "$OS" in
  linux)
    curl -fsSL -o /tmp/doppler.deb "https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_VERSION}/doppler_${DOPPLER_VERSION}_linux_${ARCH}.deb"
    sudo dpkg -i /tmp/doppler.deb
    rm /tmp/doppler.deb
    ;;
  darwin)
    curl -fsSL -o /tmp/doppler.tar.gz "https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_VERSION}/doppler_${DOPPLER_VERSION}_macOS_${ARCH}.tar.gz"
    tar -xzf /tmp/doppler.tar.gz -C /tmp
    sudo mv /tmp/doppler /usr/local/bin/
    rm /tmp/doppler.tar.gz
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

echo "Installing NVM"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1090
# NVM source returns exit code 3 if no default version is set, which is fine
source "$NVM_DIR/nvm.sh" || true

echo "Using Node.js version $NODE_VERSION"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "Configuring pnpm via Corepack"
corepack enable
corepack prepare pnpm@"$PNPM_VERSION" --activate

echo "Setting up doppler (using DOPPLER_TOKEN env var)"
doppler setup --project os --config "$DOPPLER_CONFIG"

echo "Installing workspace dependencies"
pnpm install

echo "Running pnpm typecheck"
pnpm typecheck

echo "Running pnpm lint"
pnpm lint

echo "Running pnpm format"
pnpm format

echo "Running pnpm test"
pnpm test

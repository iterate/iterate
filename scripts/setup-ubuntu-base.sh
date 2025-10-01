#!/bin/bash

# Make bash play nicely and fail on errors
set -eo pipefail

# Node.js version to install (can be overridden via environment variable)
NODE_VERSION="${NODE_VERSION:-24.4.1}"

# Base Ubuntu setup script for all environments
# This installs common development tools and dependencies

# Install basic system dependencies
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg jq unzip

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Source nvm for this script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "Installing pnpm"
# Install pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh -
pnpm -v
pnpm setup

# Select Node version (default 24.4.1, overridable via $NODE_VERSION)
nvm install "$NODE_VERSION" && nvm use "$NODE_VERSION"
pnpm env use --global "$NODE_VERSION"

# Install bun
curl -fsSL https://bun.sh/install | bash

sudo mkdir -p /usr/share/keyrings

# Install doppler CLI
## 1. Fetch the repo’s signing key and convert it to binary format
curl -fsSL https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key \
 | sudo gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
## 2. Add the repository, pointing APT at that specific key
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] \
  https://packages.doppler.com/public/cli/deb/debian any-version main" \
  | sudo tee /etc/apt/sources.list.d/doppler-cli.list
## 3. Install / upgrade
sudo apt-get update
sudo apt-get install doppler -y

# install gh cli
## 1. Fetch the repo’s signing key and convert it to binary format
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
## 2. Add the repository, pointing APT at that specific key
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
  https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list
## 3. Install / upgrade
sudo apt-get update
sudo apt-get install gh -y

# Set up environment variables and PATH
export PNPM_HOME=~/.local/share/pnpm
export PATH="$PNPM_HOME:$PATH"
echo 'export PNPM_HOME=~/.local/share/pnpm' >> ~/.bashrc
echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.bashrc
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> ~/.bashrc
mkdir -p $PNPM_HOME

# Install playwright system dependencies
# sudo apt-get update && sudo apt-get install -y \
#     curl \
#     wget \
#     git \
#     build-essential \
#     unzip \
#     sudo \
#     && rm -rf /var/lib/apt/lists/* \
#     && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu

# sudo apt-get install -y \
#     libnss3-dev \
#     libatk-bridge2.0-dev \
#     libdrm-dev \
#     libxkbcommon-dev \
#     libgtk-3-dev \
#     libgbm-dev \
#     libasound2-dev 

# pnpm install -g vibe-tools@latest playwright@latest

# playwright install-deps chromium chrome chromium-headless-shell && playwright install chromium chrome chromium-headless-shell

# Make sure shell sources the right files
echo 'source ~/.bashrc' >> ~/.profile

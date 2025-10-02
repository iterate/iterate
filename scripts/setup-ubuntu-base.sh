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

# Set up pnpm in PATH immediately after installation
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

pnpm -v
pnpm setup

# Select Node version (default 24.4.1, overridable via $NODE_VERSION)
nvm install "$NODE_VERSION" && nvm use "$NODE_VERSION"
pnpm env use --global "$NODE_VERSION"

# Install node-gyp globally for native module compilation
pnpm add -g node-gyp

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

# Add environment variables to bashrc for future sessions (already set above for current session)
echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.bashrc
echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.bashrc
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> ~/.bashrc

for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do sudo apt-get remove $pkg; done

# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl -y
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update

 sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y

# add current user to the docker group (use whoami to get current username)
sudo usermod -aG docker "$(whoami)"

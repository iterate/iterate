set -eo pipefail

NODE_VERSION="${NODE_VERSION:-24.4.1}"
PNPM_VERSION="${PNPM_VERSION:-10.17.1}"

(curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh || wget -t 3 -qO- https://cli.doppler.com/install.sh) | sudo sh

echo "Installing NVM"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

echo "Using Node.js version $NODE_VERSION"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "Configuring pnpm via Corepack"
corepack enable
corepack prepare pnpm@"$PNPM_VERSION" --activate

echo "Setting up doppler (using DOPPLER_TOKEN env var)"
doppler setup --project os --config dev_codex

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
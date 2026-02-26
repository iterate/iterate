#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~ so the entire home directory
# persists across machine reprovisioning.
#
# First boot (empty disk): copies dotfiles from image, clones iterate repo, pnpm install.
# Subsequent boots: archil already has everything from a previous machine's session.
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
#   GIT_SHA            — image git sha, used to clone the correct version on first boot
set -euo pipefail

MOUNT_POINT="/home/iterate"
ITERATE_REPO="${ITERATE_REPO:-${MOUNT_POINT}/src/github.com/iterate/iterate}"

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "${MOUNT_POINT}/.iterate/.env" ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "${MOUNT_POINT}/.iterate/.env")"
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
  exec sleep infinity
fi

# Already mounted? Sleep to keep process alive.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted at ${MOUNT_POINT}"
  exec sleep infinity
fi

# Archil CLI expects provider-prefixed region (e.g. aws-us-east-1)
ARCHIL_CLI_REGION="${ARCHIL_REGION:-us-east-1}"
case "${ARCHIL_CLI_REGION}" in
  aws-*|gcp-*) ;; # already prefixed
  *) ARCHIL_CLI_REGION="aws-${ARCHIL_CLI_REGION}" ;;
esac

export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN:-}"

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${MOUNT_POINT} (region: ${ARCHIL_CLI_REGION})"

# Snapshot dotfiles from image BEFORE mount hides them. The image's home dir has
# dotfiles, tool configs, etc. that we want on first boot.
# Exclude src/ (the baked-in repo — we'll clone a fresh one).
if [[ ! -d /tmp/home-seed ]]; then
  rsync -a --exclude='src/' "${MOUNT_POINT}/" /tmp/home-seed/ 2>/dev/null || true
  echo "[archil] Saved home-seed snapshot"
fi

# Post-mount tasks run in background since --no-fork blocks the main thread.
(
  while ! grep -q "archil" /proc/mounts 2>/dev/null; do sleep 1; done
  echo "[archil] Mount detected"

  sudo chown iterate:iterate "${MOUNT_POINT}"

  # First boot: if the disk has no .bashrc, it's a fresh/empty disk.
  if [[ ! -f "${MOUNT_POINT}/.bashrc" ]]; then
    echo "[archil] First boot — setting up persistent home directory"

    # 1. Seed dotfiles/configs from image snapshot
    if [[ -d /tmp/home-seed ]]; then
      cp -a /tmp/home-seed/. "${MOUNT_POINT}/"
      echo "[archil] Dotfiles seeded"
    fi

    # 2. Clone iterate repo and install deps
    REPO_DIR="${MOUNT_POINT}/src/github.com/iterate/iterate"
    mkdir -p "$(dirname "$REPO_DIR")"

    REPO_URL="${ITERATE_REPO_URL:-https://github.com/nichochar/iterate.git}"
    REPO_REF="${GIT_SHA:-main}"

    echo "[archil] Cloning ${REPO_URL} @ ${REPO_REF}"
    git clone --depth 1 --branch main "$REPO_URL" "$REPO_DIR" 2>&1 || {
      # If branch clone fails, try cloning then checking out the sha
      git clone "$REPO_URL" "$REPO_DIR" 2>&1
    }

    # Checkout the specific sha if it's not 'main' or 'unknown'
    if [[ "$REPO_REF" != "main" ]] && [[ "$REPO_REF" != "unknown" ]]; then
      cd "$REPO_DIR"
      git fetch origin "$REPO_REF" 2>/dev/null || true
      git checkout "$REPO_REF" 2>/dev/null || echo "[archil] Warning: could not checkout ${REPO_REF}, staying on main"
    fi

    # 3. Install dependencies
    echo "[archil] Installing dependencies (pnpm install)"
    cd "$REPO_DIR"
    pnpm install --frozen-lockfile 2>&1

    # 4. Run post-sync steps (builds daemon frontend, runs migrations, etc.)
    echo "[archil] Running post-sync steps"
    bash "$REPO_DIR/sandbox/after-repo-sync-steps.sh" 2>&1

    # 5. Init git repo for tools that need it
    git add . 2>/dev/null || true
    git commit -m "archil first boot" 2>/dev/null || true

    echo "[archil] First boot setup complete"
  else
    echo "[archil] Existing home directory found, skipping setup"
  fi

  # Signal that the home directory is ready for other processes
  touch /tmp/archil-home-ready
  echo "[archil] Home directory ready"
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
# --log-dir: log to file for debugging.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${MOUNT_POINT}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.

#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
# Mounts the project's Archil disk at ~ so the entire home directory
# persists across machine reprovisioning.
#
# All tools (mitmdump, claude, opencode, bun, fly, etc.) are installed
# to system paths (/opt/, /usr/local/) by the Dockerfile, so they survive
# the bind-mount. Archil only needs to persist dotfiles, the repo clone,
# and pnpm install.
#
# First boot (empty disk): seeds dotfiles from image, clones iterate repo, pnpm install.
# Subsequent boots: archil already has everything from a previous machine's session.
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
#   GIT_SHA            — image git sha, used to clone the correct version on first boot
set -euo pipefail

MOUNT_POINT="/home/iterate"
STAGING="/mnt/archil-staging"
ITERATE_REPO="${ITERATE_REPO:-${MOUNT_POINT}/src/github.com/iterate/iterate}"

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "${MOUNT_POINT}/.iterate/.env" ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "${MOUNT_POINT}/.iterate/.env")"
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
  # Signal that the repo is ready (it's baked into the image)
  touch /tmp/archil-repo-ready
  exec sleep infinity
fi

# Already mounted? Sleep to keep process alive.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted"
  # Ensure bind mount is in place (may have been lost on restart)
  if ! mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    echo "[archil] Re-establishing bind mount ${STAGING} -> ${MOUNT_POINT}"
    sudo mount --bind "$STAGING" "$MOUNT_POINT"
    touch /tmp/archil-home-ready
  fi
  touch /tmp/archil-repo-ready
  exec sleep infinity
fi

# Archil CLI expects provider-prefixed region (e.g. aws-us-east-1)
ARCHIL_CLI_REGION="${ARCHIL_REGION:-us-east-1}"
case "${ARCHIL_CLI_REGION}" in
  aws-*|gcp-*) ;; # already prefixed
  *) ARCHIL_CLI_REGION="aws-${ARCHIL_CLI_REGION}" ;;
esac

export ARCHIL_MOUNT_TOKEN="${ARCHIL_MOUNT_TOKEN:-}"

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${STAGING} -> ${MOUNT_POINT} (region: ${ARCHIL_CLI_REGION})"

# Archil FUSE (libfuse2) refuses to mount on a non-empty directory.
# Mount to an empty staging dir first, then bind-mount over ~.
sudo mkdir -p "$STAGING"

# Post-mount tasks run in background since --no-fork blocks the main thread.
(
  set +e  # Don't exit on errors — we need to complete setup even if individual steps fail
  trap 'echo "[archil] Background task error on line $LINENO: $BASH_COMMAND (exit $?)"' ERR

  # Wait for archil to mount at the staging dir
  while ! grep -q "$STAGING" /proc/mounts 2>/dev/null; do sleep 1; done
  echo "[archil] Archil mounted at ${STAGING}"

  # Only chown the mount point itself (not -R). Files inside are already owned
  # by iterate from previous boots or will be created by iterate.
  # Recursive chown over FUSE is extremely slow (minutes for large dirs).
  sudo chown iterate:iterate "$STAGING"

  # Bind-mount IMMEDIATELY so other processes can use ~ without waiting for clone.
  echo "[archil] Bind-mounting ${STAGING} over ${MOUNT_POINT}"
  sudo mount --bind "$STAGING" "$MOUNT_POINT"

  # Signal that the home directory is ready for other processes
  touch /tmp/archil-home-ready
  echo "[archil] Home directory ready"

  # First boot: check for the repo as the signal that setup completed successfully.
  # (Using .bashrc was unreliable — shared R2 buckets can have stale dotfiles.)
  REPO_DIR="${STAGING}/src/github.com/iterate/iterate"
  if [[ ! -f "${REPO_DIR}/package.json" ]]; then
    echo "[archil] First boot — seeding dotfiles, cloning repo, installing deps"

    # Seed dotfiles from the image's home-skeleton (baked into the repo copy).
    # These provide .bashrc, .profile, .gitconfig, .npmrc, etc.
    SKELETON="${STAGING}/src/github.com/iterate/iterate/sandbox/home-skeleton"
    # The repo isn't cloned yet, so use the image's copy at the original path
    IMAGE_SKELETON="/home/iterate/src/github.com/iterate/iterate/sandbox/home-skeleton"
    # On first boot the bind-mount hides the original ~ — but we can read from
    # the image via /proc/1/root if needed. However, the skeleton files are also
    # in the COPY'd repo. Since we haven't bind-mounted yet... actually we have.
    # Use a pre-stashed copy: the Dockerfile COPY'd the repo, so the files exist
    # at the ITERATE_REPO path under the original mount. But the bind-mount now
    # hides them. Fortunately rsync from image overlay still works via /proc:
    # Actually, simplest: we stash the skeleton to /opt/home-skeleton in the Dockerfile.
    # But we didn't do that. Let's just inline the critical dotfiles here.
    # The sync-home-skeleton.sh will run later when the repo is cloned.
    
    # Seed minimal dotfiles so the shell works before repo clone
    sudo mkdir -p "${STAGING}/.iterate/bin"
    sudo chown -R iterate:iterate "${STAGING}/.iterate"
    # .bashrc and .profile will be synced later from the cloned repo

    # Ensure parent dirs exist and are writable by iterate.
    # On shared R2 buckets, old dirs from previous disks may be root-owned.
    sudo mkdir -p "$(dirname "$REPO_DIR")"
    sudo chown iterate:iterate "${STAGING}" "${STAGING}/src" "${STAGING}/src/github.com" "${STAGING}/src/github.com/iterate" 2>/dev/null || true

    # Fix ownership of dirs that may be root-owned from shared R2 bucket stale data.
    # These are needed by pnpm, npm, opencode, etc. during first-boot install.
    for dir in .cache .config .local .npm-global; do
      if [[ -d "${STAGING}/${dir}" ]]; then
        sudo chown -R iterate:iterate "${STAGING}/${dir}" 2>/dev/null || true
      fi
    done

    REPO_URL="${ITERATE_REPO_URL:-https://github.com/iterate/iterate.git}"
    REPO_REF="${GIT_SHA:-main}"

    # Wait for egress proxy (port 8888) — needed for HTTPS traffic
    echo "[archil] Waiting for egress proxy on port 8888..."
    for i in $(seq 1 60); do
      if bash -c 'echo > /dev/tcp/127.0.0.1/8888' 2>/dev/null; then
        echo "[archil] Egress proxy ready"
        break
      fi
      sleep 1
    done

    # Clone the repo. On first boot, GitHub credentials aren't available yet
    # (daemon must report ready before the OS pushes creds). For public repos
    # like iterate/iterate, bypass the credential helper and clone anonymously.
    # For private repos, retry with backoff until creds arrive.
    rm -rf "$REPO_DIR" 2>/dev/null; sudo rm -rf "$REPO_DIR" 2>/dev/null || true
    echo "[archil] Cloning ${REPO_URL} @ ${REPO_REF}"
    CLONE_OK=false
    for attempt in $(seq 1 3); do
      # Anonymous clone: bypass credential helper AND egress proxy.
      # On first boot, GitHub creds aren't provisioned yet (daemon must report ready first).
      # Public repos like iterate/iterate can be cloned without auth.
      # The egress proxy's magic token swap causes 401 when creds aren't ready,
      # so we bypass both the proxy and the credential helper.
      if GIT_TERMINAL_PROMPT=0 HTTPS_PROXY="" HTTP_PROXY="" https_proxy="" http_proxy="" \
         GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
         git clone --depth 1 --branch main "$REPO_URL" "$REPO_DIR" 2>&1; then
        CLONE_OK=true
        break
      fi
      rm -rf "$REPO_DIR" 2>/dev/null; sudo rm -rf "$REPO_DIR" 2>/dev/null || true
      echo "[archil] Clone attempt $attempt failed, retrying in ${attempt}0s..."
      sleep $((attempt * 10))
    done

    if [[ "$CLONE_OK" != "true" ]]; then
      echo "[archil] ERROR: All clone attempts failed. Skipping repo setup."
    else
      # Checkout the specific sha if it's not 'main' or 'unknown'
      if [[ "$REPO_REF" != "main" ]] && [[ "$REPO_REF" != "unknown" ]]; then
        cd "$REPO_DIR"
        git fetch origin "$REPO_REF" 2>/dev/null || true
        git checkout "$REPO_REF" 2>/dev/null || echo "[archil] Warning: could not checkout ${REPO_REF}, staying on main"
      fi

      # Sync home-skeleton dotfiles from the cloned repo
      echo "[archil] Syncing home-skeleton dotfiles"
      cd "$REPO_DIR"
      bash "$REPO_DIR/sandbox/sync-home-skeleton.sh" 2>&1 || echo "[archil] Warning: sync-home-skeleton failed"

      # Install dependencies
      echo "[archil] Installing dependencies (pnpm install)"
      cd "$REPO_DIR"
      if ! pnpm install --frozen-lockfile 2>&1; then
        echo "[archil] ERROR: pnpm install failed (exit $?)"
      fi

      # Run post-sync steps (builds daemon frontend, runs migrations, etc.)
      echo "[archil] Running post-sync steps"
      bash "$REPO_DIR/sandbox/after-repo-sync-steps.sh" 2>&1 || echo "[archil] Warning: after-repo-sync-steps failed"

      # Install Chromium for agent-browser (persists on archil disk across machines)
      echo "[archil] Installing agent-browser chromium"
      agent-browser install 2>&1 || echo "[archil] Warning: agent-browser install failed"

      # Init git repo for tools that need it
      git add . 2>/dev/null || true
      git commit -m "archil first boot" 2>/dev/null || true

      echo "[archil] First boot setup complete"
    fi
  else
    echo "[archil] Existing home directory found"
  fi

  # Signal that the repo is available (either from clone or previous boot)
  touch /tmp/archil-repo-ready
  echo "[archil] Repo ready signal written"
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
# --log-dir: log to file for debugging.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${STAGING}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.

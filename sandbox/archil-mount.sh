#!/bin/bash
# Archil persistent volume mount — managed by pidnap.
#
# Strategy: mount archil at /mnt/persist (NOT over ~). The Docker image
# already has the repo + node_modules baked in at ~/src/..., so boot is
# instant — no clone or pnpm install needed.
#
# Archil persists lightweight state that matters across reprovisioning:
#   - Dotfiles (.bashrc, .profile, .gitconfig, .npmrc)
#   - Uncommitted code changes (synced periodically by archil-git-sync)
#   - OpenCode / Claude session state
#   - Agent browser chromium cache
#   - SSH keys, credentials pushed by the platform
#
# On first boot: copies dotfiles from image to archil.
# On subsequent boots: restores persisted state via symlinks.
#
# Env vars (from process env, set by Fly from project env vars):
#   ARCHIL_DISK_NAME   — disk ID (e.g. dsk-0000000000003139)
#   ARCHIL_MOUNT_TOKEN — auth token for mount
#   ARCHIL_REGION      — region (e.g. us-east-1, auto-prefixed to aws-us-east-1)
set -euo pipefail

HOME_DIR="/home/iterate"
PERSIST="/mnt/persist"

# Source env vars from .env files if not already set via process env
if [[ -z "${ARCHIL_DISK_NAME:-}" ]] && [[ -f "${HOME_DIR}/.iterate/.env" ]]; then
  eval "$(grep -E '^(ARCHIL_DISK_NAME|ARCHIL_MOUNT_TOKEN|ARCHIL_REGION)=' "${HOME_DIR}/.iterate/.env")"
fi

if [[ -z "${ARCHIL_DISK_NAME:-}" ]]; then
  echo "[archil] No ARCHIL_DISK_NAME set, skipping mount"
  touch /tmp/archil-repo-ready
  exec sleep infinity
fi

build_persist_dirs() {
  local -a defaults=(
    ".iterate"             # platform config, credentials, bin wrappers
    ".ssh"                 # SSH keys
    ".config/opencode"     # opencode config + agents prompts
    ".cache/opencode"      # opencode cache
    ".cache/claude"        # claude session state
  )

  if [[ -n "${ARCHIL_PERSIST_DIRS:-}" ]]; then
    local -a custom
    IFS=',' read -r -a custom <<<"${ARCHIL_PERSIST_DIRS}"
    local -a cleaned=()
    local item
    for item in "${custom[@]}"; do
      item="$(echo "$item" | xargs)"
      [[ -z "$item" ]] && continue
      cleaned+=("$item")
    done
    if [[ ${#cleaned[@]} -gt 0 ]]; then
      printf '%s\n' "${cleaned[@]}"
      return
    fi
  fi

  printf '%s\n' "${defaults[@]}"
}

# Already mounted? Sleep to keep process alive.
if grep -q "archil" /proc/mounts 2>/dev/null; then
  echo "[archil] Already mounted"
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

echo "[archil] Mounting disk ${ARCHIL_DISK_NAME} at ${PERSIST} (region: ${ARCHIL_CLI_REGION})"
sudo mkdir -p "$PERSIST"

# Post-mount setup runs in background since --no-fork blocks the main thread.

(
  set +e
  trap 'echo "[archil] Background task error on line $LINENO: $BASH_COMMAND (exit $?)"' ERR

  # Wait for archil FUSE mount
  while ! grep -q "$PERSIST" /proc/mounts 2>/dev/null; do sleep 1; done
  echo "[archil] Archil mounted at ${PERSIST}"

  sudo chown iterate:iterate "$PERSIST"

  # Dirs we persist on archil and symlink into ~.
  # Override with ARCHIL_PERSIST_DIRS=dir1,dir2 if needed.
  mapfile -t PERSIST_DIRS < <(build_persist_dirs)

  # Files we persist on archil and symlink into ~
  PERSIST_FILES=(
    ".bashrc"
    ".profile"
    ".gitconfig"
    ".npmrc"
  )

  # First boot detection: check for .bashrc as signal
  if [[ ! -f "${PERSIST}/.bashrc" ]]; then
    echo "[archil] First boot — seeding persistent state from image"

    # Copy dotfiles from image home dir to persist volume
    for f in "${PERSIST_FILES[@]}"; do
      if [[ -f "${HOME_DIR}/${f}" ]]; then
        cp -a "${HOME_DIR}/${f}" "${PERSIST}/${f}"
        echo "[archil]   Copied ${f}"
      fi
    done

    # Copy dirs from image home dir to persist volume
    for d in "${PERSIST_DIRS[@]}"; do
      if [[ -d "${HOME_DIR}/${d}" ]]; then
        mkdir -p "$(dirname "${PERSIST}/${d}")"
        cp -a "${HOME_DIR}/${d}" "${PERSIST}/${d}"
        echo "[archil]   Copied ${d}/"
      else
        mkdir -p "${PERSIST}/${d}"
        echo "[archil]   Created ${d}/"
      fi
    done

    echo "[archil] First boot seeding complete"
  else
    echo "[archil] Existing persistent state found"
  fi

  # Always fix ownership on persist dirs — archil FUSE creates files as root,
  # and shared R2 buckets can leave root-owned dirs from previous boots.
  # Only chown the specific dirs we need (not the whole volume, which could
  # be slow if there's a lot of stale data from shared buckets).
  echo "[archil] Fixing ownership on persist dirs"
  sudo chown iterate:iterate "$PERSIST"
  for f in "${PERSIST_FILES[@]}"; do
    [[ -f "${PERSIST}/${f}" ]] && sudo chown iterate:iterate "${PERSIST}/${f}"
  done
  for d in "${PERSIST_DIRS[@]}"; do
    [[ -d "${PERSIST}/${d}" ]] && sudo chown -R iterate:iterate "${PERSIST}/${d}"
  done

  # Create symlinks from ~ to persist volume for files
  for f in "${PERSIST_FILES[@]}"; do
    if [[ -f "${PERSIST}/${f}" ]]; then
      # Remove the image copy and symlink to persisted version
      rm -f "${HOME_DIR}/${f}" 2>/dev/null || true
      ln -sf "${PERSIST}/${f}" "${HOME_DIR}/${f}"
    fi
  done

  # Create symlinks from ~ to persist volume for dirs
  for d in "${PERSIST_DIRS[@]}"; do
    if [[ -d "${PERSIST}/${d}" ]]; then
      # Ensure parent exists in ~
      mkdir -p "$(dirname "${HOME_DIR}/${d}")"
      # Remove image copy (if it's a real dir, not a symlink)
      if [[ -d "${HOME_DIR}/${d}" ]] && [[ ! -L "${HOME_DIR}/${d}" ]]; then
        rm -rf "${HOME_DIR}/${d}"
      fi
      ln -sfn "${PERSIST}/${d}" "${HOME_DIR}/${d}"
    fi
  done

  echo "[archil] Symlinks established"

  # Keep OpenCode sqlite on local disk (not on archil mount). A live sqlite
  # file on a network/object-backed fs can intermittently fail with:
  # "SQLiteError: file is not a database".
  OPENCODE_LOCAL_DIR="${HOME_DIR}/.local/share/opencode"
  OPENCODE_PERSIST_DIR="${PERSIST}/.local/share/opencode"
  OPENCODE_SNAPSHOT_DB="${PERSIST}/.iterate/opencode/opencode.db"

  if [[ -L "${OPENCODE_LOCAL_DIR}" ]]; then
    OPENCODE_LINK_TARGET="$(readlink -f "${OPENCODE_LOCAL_DIR}" || true)"
    if [[ -n "${OPENCODE_LINK_TARGET}" ]] && [[ "${OPENCODE_LINK_TARGET}" == "${PERSIST}"* ]]; then
      echo "[archil] Migrating opencode data dir from persisted symlink to local disk"
      mkdir -p "${HOME_DIR}/.local/share"
      rm -f "${OPENCODE_LOCAL_DIR}"
      mkdir -p "${OPENCODE_LOCAL_DIR}"
      if [[ -d "${OPENCODE_PERSIST_DIR}" ]]; then
        cp -a "${OPENCODE_PERSIST_DIR}/." "${OPENCODE_LOCAL_DIR}/" || true
      fi
    fi
  fi
  mkdir -p "${OPENCODE_LOCAL_DIR}"
  if [[ -f "${OPENCODE_SNAPSHOT_DB}" ]]; then
    echo "[archil] Restoring opencode sqlite snapshot"
    cp -f "${OPENCODE_SNAPSHOT_DB}" "${OPENCODE_LOCAL_DIR}/opencode.db"
  fi

  # Restore uncommitted git changes if a stash was saved from a previous machine
  REPO_DIR="${HOME_DIR}/src/github.com/iterate/iterate"
  PATCH_FILE="${PERSIST}/uncommitted-changes.patch"
  UNTRACKED_ARCHIVE="${PERSIST}/untracked-files.tar.gz"
  if [[ -d "$REPO_DIR/.git" ]] && ([[ -f "$PATCH_FILE" ]] || [[ -f "$UNTRACKED_ARCHIVE" ]]); then
    echo "[archil] Restoring uncommitted changes from previous machine"
    ARCHIL_PERSIST_DIR="${PERSIST}" ITERATE_REPO="${REPO_DIR}" \
      bash "${REPO_DIR}/sandbox/archil-restore-git-state.sh" 2>&1 ||
      echo "[archil] Warning: could not apply saved changes"
  fi

  # Signal that the repo is ready (it's baked into the image, no clone needed)
  touch /tmp/archil-repo-ready
  echo "[archil] Setup complete, repo ready"
) &

# --force: claim ownership even if stale delegation exists from a previous machine.
# --no-fork: keep archil in foreground so pidnap can manage the process lifecycle.
sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil mount "${ARCHIL_DISK_NAME}" "${PERSIST}" \
  --region "${ARCHIL_CLI_REGION}" \
  --force \
  --no-fork \
  --log-dir /var/log/archil

# If archil mount exits, this script exits and pidnap will restart it.

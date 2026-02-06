#!/bin/bash
set -euo pipefail

ITERATE_REPO="${ITERATE_REPO:-$HOME/src/github.com/iterate/iterate}"
HOME_SKELETON="$ITERATE_REPO/apps/os/sandbox/home-skeleton"

if [ ! -d "$HOME_SKELETON" ]; then
  echo "[sync-home-skeleton] Missing home skeleton: $HOME_SKELETON" >&2
  exit 1
fi

get_mtime() {
  if stat -c %Y "$1" >/dev/null 2>&1; then
    stat -c %Y "$1"
  else
    stat -f %m "$1"
  fi
}

warn_if_newer() {
  local src="$1"
  local rel dest src_mtime dest_mtime
  rel="${src#${HOME_SKELETON}/}"
  dest="$HOME/$rel"

  # Skip .iterate/.env - managed by daemon
  if [ "$rel" = ".iterate/.env" ]; then
    return
  fi

  if [ -e "$dest" ]; then
    src_mtime=$(get_mtime "$src")
    dest_mtime=$(get_mtime "$dest")
    if [ "$dest_mtime" -gt "$src_mtime" ]; then
      echo "[sync-home-skeleton] $dest is newer than source; overwriting anyway"
    fi
  fi
}

while IFS= read -r -d '' src; do
  warn_if_newer "$src"
done < <(find "$HOME_SKELETON" \( -type f -o -type l \) -print0)

# Exclude .iterate/.env only if it already exists (daemon injects env vars into it)
# On first sync we need to copy it so DUMMY_ENV_VAR etc are present
if [ -f "$HOME/.iterate/.env" ]; then
  rsync -a --exclude='.iterate/.env' "$HOME_SKELETON/" "$HOME/"
else
  rsync -a "$HOME_SKELETON/" "$HOME/"
fi

chmod +x "$HOME/.local/bin/"* "$HOME/.iterate/bin/"* 2>/dev/null || true

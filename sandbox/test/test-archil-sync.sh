#!/bin/bash
# End-to-end check for archil git state sync/restore across machine handoff.
# Simulates two machines with two git worktrees:
#   machine A -> archil-git-sync.sh writes persist artifacts
#   machine B -> archil-restore-git-state.sh restores artifacts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[archil-sync-test]${NC} $1"; }
fail() { echo -e "${RED}[archil-sync-test]${NC} $1"; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PERSIST_DIR="${TMP_DIR}/persist"
SRC_REPO="${TMP_DIR}/machine-a-repo"
DST_REPO="${TMP_DIR}/machine-b-repo"

mkdir -p "${PERSIST_DIR}" "${SRC_REPO}"

log "Creating baseline git repo (machine A)"
git -C "${SRC_REPO}" init >/dev/null
git -C "${SRC_REPO}" config user.email "archil-test@example.com"
git -C "${SRC_REPO}" config user.name "archil-test"
cat > "${SRC_REPO}/tracked.txt" <<'EOF'
base
EOF
git -C "${SRC_REPO}" add tracked.txt
git -C "${SRC_REPO}" commit -m "baseline" >/dev/null

log "Cloning baseline to machine B"
git clone "${SRC_REPO}" "${DST_REPO}" >/dev/null 2>&1

log "Creating tracked + untracked changes on machine A"
cat > "${SRC_REPO}/tracked.txt" <<'EOF'
changed-on-machine-a
EOF
mkdir -p "${SRC_REPO}/notes"
cat > "${SRC_REPO}/notes/untracked.md" <<'EOF'
hello from untracked file
EOF

log "Running one-shot archil git sync"
ARCHIL_PERSIST_DIR="${PERSIST_DIR}" \
ITERATE_REPO="${SRC_REPO}" \
ARCHIL_GIT_SYNC_RUN_ONCE=true \
ARCHIL_GIT_SYNC_SKIP_MOUNT_WAIT=true \
bash "${REPO_ROOT}/sandbox/archil-git-sync.sh"

[[ -f "${PERSIST_DIR}/uncommitted-changes.patch" ]] || fail "Missing tracked patch artifact"
[[ -f "${PERSIST_DIR}/untracked-files.tar.gz" ]] || fail "Missing untracked archive artifact"

log "Restoring on machine B"
ARCHIL_PERSIST_DIR="${PERSIST_DIR}" \
ITERATE_REPO="${DST_REPO}" \
bash "${REPO_ROOT}/sandbox/archil-restore-git-state.sh"

TRACKED_CONTENT="$(cat "${DST_REPO}/tracked.txt")"
[[ "${TRACKED_CONTENT}" == "changed-on-machine-a" ]] || fail "Tracked change was not restored"

[[ -f "${DST_REPO}/notes/untracked.md" ]] || fail "Untracked file was not restored"
UNTRACKED_CONTENT="$(cat "${DST_REPO}/notes/untracked.md")"
[[ "${UNTRACKED_CONTENT}" == "hello from untracked file" ]] || fail "Untracked content mismatch"

log "PASS: tracked + untracked changes restore across machine handoff"

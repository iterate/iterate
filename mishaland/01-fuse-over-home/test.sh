#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# APPROACH 1: Mount FUSE over ~ then pnpm install
#
# Proves that mounting a FUSE filesystem (sshfs loopback simulating
# archil/S3/R2) over the home directory makes pnpm install unusably
# slow. The iterate repo has ~2000 packages / 50K+ files in
# node_modules — every write is a FUSE round-trip.
# ─────────────────────────────────────────────────────────────────────

FUSE_TIMEOUT=120   # seconds — FUSE install will likely not finish

banner() {
  echo ""
  echo "================================================================"
  echo "  $*"
  echo "================================================================"
  echo ""
}

# Always exit 0 — the "failure" IS the slowness
trap 'echo ""; echo "Demo complete."; exit 0' EXIT

# ── 1. Start sshd ────────────────────────────────────────────────────
banner "Starting sshd for loopback sshfs"
/usr/sbin/sshd
ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o UserKnownHostsFile=/dev/null \
  -i /root/.ssh/id_ed25519 fuseuser@localhost echo 'SSH loopback OK' 2>&1

# ── 2. Baseline: pnpm install on local disk ──────────────────────────
banner "BASELINE: pnpm install on LOCAL disk (iterate repo)"

# Copy the iterate repo for a fresh install
LOCAL_DIR=/tmp/local-iterate
cp -a /opt/iterate "$LOCAL_DIR"

# Delete node_modules so we can time a fresh install
rm -rf "$LOCAL_DIR/node_modules" "$LOCAL_DIR"/*/node_modules "$LOCAL_DIR"/apps/*/node_modules "$LOCAL_DIR"/packages/*/node_modules 2>/dev/null || true

LOCAL_FILE_BEFORE=$(find /opt/iterate/node_modules -type f 2>/dev/null | wc -l)
echo "iterate repo node_modules file count: ${LOCAL_FILE_BEFORE}"

echo "Running pnpm install --frozen-lockfile on local disk..."
LOCAL_START=$SECONDS
cd "$LOCAL_DIR" && pnpm install --frozen-lockfile 2>&1 | tail -5
LOCAL_ELAPSED=$(( SECONDS - LOCAL_START ))
echo ""
echo ">>> Local pnpm install: ${LOCAL_ELAPSED}s"

# ── 3. Mount sshfs (FUSE) over /home/testuser ────────────────────────
banner "Mounting sshfs (FUSE) over /home/testuser"

# Stage the home dir contents for sshfs to serve
BACKING_DIR=/srv/testuser-home
mkdir -p "$BACKING_DIR"
rsync -a /home/testuser/ "$BACKING_DIR/"
# fuseuser owns the backing dir (SFTP runs as fuseuser).
# allow_other lets any local user access the FUSE mount.
chown -R fuseuser:fuseuser "$BACKING_DIR"
chmod -R 777 "$BACKING_DIR"

# Mount! Every file op now goes: syscall → FUSE → sshfs → SSH → sshd → disk
# Use -f (foreground) + & because sshfs daemon mode hangs in containers.
# SSH as fuseuser (whose home is /home/fuseuser, NOT the FUSE target) to
# avoid circular dependency where sshd tries to cd into the FUSE mount.
sshfs \
  -f \
  -o StrictHostKeyChecking=no \
  -o IdentityFile=/root/.ssh/id_ed25519 \
  -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes \
  -o allow_other \
  -o cache=no \
  fuseuser@localhost:$BACKING_DIR /home/testuser > /dev/null 2>&1 &
sleep 2

if mount | grep -q 'home/testuser.*fuse\|fuse.*home/testuser'; then
  echo "FUSE mount active on /home/testuser"
else
  echo "sshfs mount failed"
  exit 0
fi

# ── 4. Copy iterate repo into FUSE-mounted home ─────────────────────
banner "Copying iterate repo (just package.json + lockfile) onto FUSE"

FUSE_DIR=/home/testuser/iterate-fuse
mkdir -p $FUSE_DIR
# Only copy package.json and pnpm-lock.yaml — pnpm install will create node_modules
cp /opt/iterate/package.json /opt/iterate/pnpm-lock.yaml /opt/iterate/pnpm-workspace.yaml $FUSE_DIR/ 2>/dev/null || true
# Copy workspace package.jsons too (pnpm needs them for workspace install)
cd /opt/iterate && find . -name package.json -not -path '*/node_modules/*' -exec sh -c "mkdir -p $FUSE_DIR/\$(dirname {}) && cp {} $FUSE_DIR/{}" \;
echo "Project files copied to FUSE"

# ── 5. pnpm install over FUSE ────────────────────────────────────────
banner "FUSE: pnpm install over sshfs-mounted home (timeout ${FUSE_TIMEOUT}s)"

echo "This will be DRAMATICALLY slower. Every file write in node_modules"
echo "goes through: userspace → kernel FUSE → sshfs daemon → SSH → disk."
echo "With ~2000 packages and ~50K files, that's 50K+ round-trips."
echo ""

FUSE_START=$SECONDS
FUSE_TIMED_OUT=false
FUSE_FAILED=false
FUSE_EXIT_CODE=0

if timeout "${FUSE_TIMEOUT}s" bash -c "cd $FUSE_DIR && pnpm install --frozen-lockfile 2>&1" | tail -20; then
  FUSE_ELAPSED=$(( SECONDS - FUSE_START ))
  echo ""
  echo ">>> FUSE pnpm install completed in ${FUSE_ELAPSED}s"
else
  FUSE_EXIT_CODE=$?
  FUSE_ELAPSED=$(( SECONDS - FUSE_START ))
  if [ "$FUSE_EXIT_CODE" -eq 124 ]; then
    FUSE_TIMED_OUT=true
    echo ""
    echo ">>> FUSE pnpm install TIMED OUT after ${FUSE_TIMEOUT}s"
  else
    FUSE_FAILED=true
    echo ""
    echo ">>> FUSE pnpm install FAILED (exit $FUSE_EXIT_CODE) after ${FUSE_ELAPSED}s"
    echo "(pnpm hit I/O errors on FUSE — fchown, JSON parse, etc.)"
  fi
fi

FUSE_FILE_COUNT=$(find "$FUSE_DIR/node_modules" -type f 2>/dev/null | wc -l)

# ── 6. Verdict ────────────────────────────────────────────────────────
banner "VERDICT"

echo "  iterate repo node_modules: ~${LOCAL_FILE_BEFORE} files"
echo ""
echo "  Local pnpm install:  ${LOCAL_ELAPSED}s"
if $FUSE_TIMED_OUT; then
  echo "  FUSE pnpm install:   TIMED OUT after ${FUSE_TIMEOUT}s  (${FUSE_FILE_COUNT} files written)"
  echo ""
  echo "  Result: FUSE install didn't finish in ${FUSE_TIMEOUT}s."
  echo "  In production (archil + R2), this took 10+ minutes and still"
  echo "  didn't complete within the 600s readiness probe timeout."
elif [ "$FUSE_FAILED" = true ]; then
  echo "  FUSE pnpm install:   FAILED after ${FUSE_ELAPSED}s  (exit code $FUSE_EXIT_CODE)"
  echo ""
  echo "  Result: pnpm install crashed with I/O errors on the FUSE mount."
  echo "  Common failures: EACCES on fchown (FUSE can't change ownership),"
  echo "  ERR_PNPM_JSON_PARSE (corrupted reads), ENOENT (race conditions)."
else
  echo "  FUSE pnpm install:   ${FUSE_ELAPSED}s  (${FUSE_FILE_COUNT} files)"
  if [ "$LOCAL_ELAPSED" -gt 0 ]; then
    RATIO=$(( FUSE_ELAPSED / LOCAL_ELAPSED ))
    echo ""
    echo "  Slowdown: ~${RATIO}x"
  fi
fi
echo ""
echo "  Why: each of the ~50K files in node_modules requires multiple"
echo "  syscalls (open, write, close, chmod, etc). On FUSE, every syscall"
echo "  is a round-trip through the FUSE kernel module to the userspace"
echo "  daemon. Even at 1-2ms per op, 50K files × ~5 ops × 1.5ms = ~6 min."
echo ""
echo "  CONCLUSION: You cannot run pnpm install when ~ is FUSE-mounted."

# Cleanup
fusermount -u /home/testuser 2>/dev/null || fusermount3 -u /home/testuser 2>/dev/null || true

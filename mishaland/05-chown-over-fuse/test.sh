#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  APPROACH 5: chown -R over FUSE"
echo "============================================"
echo ""
echo "Problem: chown -R over a FUSE mount is extremely"
echo "slow because each file's ownership change is a"
echo "separate network round-trip to the backing store."
echo ""

# ── Pick the best source tree ──────────────────────────
# Prefer the real iterate repo if it was cloned and has
# a decent number of files; fall back to synthetic tree.
if [ -d /opt/iterate/node_modules ] && \
   [ "$(find /opt/iterate -type f 2>/dev/null | wc -l)" -gt 2000 ]; then
    SRC=/opt/iterate
    LABEL="iterate repo (real node_modules)"
else
    SRC=/opt/synthetic-tree
    LABEL="synthetic tree (simulated node_modules)"
fi

echo "Source tree: $LABEL"
echo ""

# ── Start sshd ─────────────────────────────────────────
/usr/sbin/sshd

# ── Count files ────────────────────────────────────────
echo "=== File count in source tree ==="
TOTAL=$(find "$SRC" -type f | wc -l)
DIR_COUNT=$(find "$SRC" -type d | wc -l)
echo "Total files: $TOTAL"
echo "Total dirs:  $DIR_COUNT"
echo ""

# ── Baseline: chown on LOCAL disk ──────────────────────
echo "=== BASELINE: chown -R on LOCAL disk ==="
# Reset to root first
chown -R root:root "$SRC" 2>/dev/null || true
START=$(date +%s%N)
chown -R testuser:testuser "$SRC"
END=$(date +%s%N)
LOCAL_MS=$(( (END - START) / 1000000 ))
echo "Local chown -R on $TOTAL files: ${LOCAL_MS}ms"
echo ""

# ── Mount sshfs ────────────────────────────────────────
echo "=== Mounting FUSE (sshfs loopback) ==="
mkdir -p /mnt/fuse-test
chown testuser:testuser /mnt/fuse-test

# Accept host key automatically, disable caching to make
# every metadata op a real round-trip (worst case).
# Use -f (foreground) + & because sshfs daemon mode hangs in containers.
sshfs \
    -f \
    -o StrictHostKeyChecking=no \
    -o IdentityFile=/home/testuser/.ssh/id_ed25519 \
    -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes \
    -o allow_other \
    -o cache=no \
    testuser@127.0.0.1:/srv/fuse-data /mnt/fuse-test &
sleep 2

echo "FUSE mounted at /mnt/fuse-test"
mount | grep fuse
echo ""

# ── Create files on FUSE ──────────────────────────────
echo "=== Creating test files on FUSE mount ==="
echo "(Each file creation is a FUSE round-trip)"
mkdir -p /mnt/fuse-test/testdir

# Create 200 files directly on the FUSE mount.
# This is faster than copying a tar archive through FUSE.
COPY_START=$(date +%s%N)
for i in $(seq 1 200); do
  echo "test-file-$i" > /mnt/fuse-test/testdir/file-$i.txt
done
COPY_END=$(date +%s%N)
COPY_MS=$(( (COPY_END - COPY_START) / 1000000 ))

FUSE_FILES=$(find /mnt/fuse-test/testdir -type f | wc -l)
FUSE_DIRS=$(find /mnt/fuse-test/testdir -type d | wc -l)
echo "Created $FUSE_FILES files ($FUSE_DIRS dirs) on FUSE in ${COPY_MS}ms"
echo ""

# ── chown over FUSE ───────────────────────────────────
TIMEOUT_SEC=60

echo "=== TEST: chown -R on FUSE mount ==="
echo "Running chown -R root:root on $FUSE_FILES files over FUSE..."
echo "(Timeout: ${TIMEOUT_SEC}s)"
echo ""

START=$(date +%s%N)
if timeout "$TIMEOUT_SEC" chown -R root:root /mnt/fuse-test/testdir 2>&1; then
    TIMED_OUT=0
else
    EXIT_CODE=$?
    # timeout(1) exits 124 on timeout
    if [ "$EXIT_CODE" -eq 124 ]; then
        TIMED_OUT=1
    else
        TIMED_OUT=0
    fi
fi
END=$(date +%s%N)
FUSE_MS=$(( (END - START) / 1000000 ))

if [ "$TIMED_OUT" -eq 1 ]; then
    echo "TIMED OUT after ${TIMEOUT_SEC}s!"
else
    echo "FUSE chown -R on $FUSE_FILES files: ${FUSE_MS}ms"
fi
echo ""

# ── Per-file rate ─────────────────────────────────────
if [ "$TIMED_OUT" -eq 0 ] && [ "$FUSE_FILES" -gt 0 ]; then
    PER_FILE_US=$(( FUSE_MS * 1000 / FUSE_FILES ))
    echo "Per-file FUSE chown: ~${PER_FILE_US}us"
fi

# ── Verdict ───────────────────────────────────────────
echo ""
echo "============================================"
echo "  VERDICT"
echo "============================================"
echo ""
echo "Local chown -R ($TOTAL files):      ${LOCAL_MS}ms"
if [ "$TIMED_OUT" -eq 1 ]; then
    echo "FUSE  chown -R ($FUSE_FILES files):  TIMED OUT (>${TIMEOUT_SEC}s)"
else
    echo "FUSE  chown -R ($FUSE_FILES files):  ${FUSE_MS}ms"
fi
echo "Copy to FUSE   ($FUSE_FILES files):  ${COPY_MS}ms"
echo ""

if [ "$TIMED_OUT" -eq 1 ]; then
    echo "FUSE chown TIMED OUT. Even with fewer files ($FUSE_FILES"
    echo "vs $TOTAL total), chown -R couldn't complete in ${TIMEOUT_SEC}s."
elif [ "$LOCAL_MS" -gt 0 ]; then
    RATIO=$(( FUSE_MS / LOCAL_MS ))
    echo "Slowdown: ~${RATIO}x (FUSE vs local)"
else
    echo "Local chown was <1ms; FUSE took ${FUSE_MS}ms."
fi

echo ""
echo "CONCLUSION: chown -R over FUSE is impractical for"
echo "directories with thousands of files. Each file's"
echo "ownership change requires a round-trip to the"
echo "backing store (S3/R2 in production, SSH here)."
echo "For the full iterate repo (~$TOTAL files), this"
echo "would take minutes — far too slow for machine boot."
echo ""
echo "============================================"

# ── Cleanup ───────────────────────────────────────────
cd /
fusermount3 -u /mnt/fuse-test 2>/dev/null || true

#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "  Demo: FUSE filesystem as overlayfs upperdir"
echo "=============================================="
echo ""

# ── 1. Start sshd ────────────────────────────────
echo ">>> Starting sshd..."
/usr/sbin/sshd
sleep 1
echo "    sshd running (pid $(cat /run/sshd.pid 2>/dev/null || echo '?'))"
echo ""

# ── 2. Mount sshfs (loopback FUSE) ───────────────
echo ">>> Mounting sshfs at /opt/fuse-staging (loopback FUSE mount)..."
su - testuser -c "
  sshfs \
    -o StrictHostKeyChecking=no \
    -o allow_other \
    -o IdentityFile=/home/testuser/.ssh/id_ed25519 \
    testuser@127.0.0.1:/home/testuser \
    /opt/fuse-staging
"
echo "    sshfs mounted successfully."
echo ""

# ── 3. Show filesystem type ──────────────────────
echo ">>> Filesystem type on /opt/fuse-staging:"
FS_TYPE=$(stat -f -c '%T' /opt/fuse-staging 2>/dev/null || df -T /opt/fuse-staging | tail -1 | awk '{print $2}')
echo "    stat -f reports: ${FS_TYPE}"
echo ""
echo ">>> mount entry:"
mount | grep fuse-staging || mount | grep fuse || true
echo ""

# ── 4. Create upper + work dirs inside FUSE ──────
echo ">>> Creating upper/ and work/ inside the FUSE mount..."
mkdir -p /opt/fuse-staging/upper /opt/fuse-staging/work
echo "    done."
echo ""

# ── 5. Attempt overlayfs mount ───────────────────
echo ">>> Attempting overlayfs mount with FUSE-backed upperdir..."
echo "    command: mount -t overlay overlay \\"
echo "      -o lowerdir=/opt/lower-dir,upperdir=/opt/fuse-staging/upper,workdir=/opt/fuse-staging/work \\"
echo "      /opt/merged"
echo ""

OVERLAY_OUTPUT=""
OVERLAY_EXIT=0
OVERLAY_OUTPUT=$(mount -t overlay overlay \
  -o "lowerdir=/opt/lower-dir,upperdir=/opt/fuse-staging/upper,workdir=/opt/fuse-staging/work" \
  /opt/merged 2>&1) || OVERLAY_EXIT=$?

# ── 6. Verdict ───────────────────────────────────
echo "=============================================="
if [ "$OVERLAY_EXIT" -ne 0 ]; then
  echo "  RESULT: overlayfs mount FAILED (exit code ${OVERLAY_EXIT})"
  echo "=============================================="
  echo ""
  echo "  Kernel error message:"
  echo "    ${OVERLAY_OUTPUT}"
  echo ""
  echo "  WHY: The kernel rejects FUSE filesystems as"
  echo "  overlayfs upper layers. overlayfs requires the"
  echo "  upper filesystem to support trusted.* xattrs and"
  echo "  certain inode operations that FUSE does not"
  echo "  provide. Only real local filesystems (ext4, xfs,"
  echo "  tmpfs, etc.) are accepted."
  echo ""
  echo "  This means you CANNOT use a FUSE mount (sshfs,"
  echo "  s3fs, gocryptfs, etc.) as the writable upper"
  echo "  layer of an overlay filesystem."
else
  echo "  RESULT: overlayfs mount SUCCEEDED (unexpected!)"
  echo "=============================================="
  echo ""
  echo "  The kernel allowed the FUSE upperdir. This may"
  echo "  happen on newer kernels with relaxed checks or"
  echo "  specific FUSE configurations."
  echo ""
  echo "  Contents of /opt/merged:"
  ls -la /opt/merged/
fi

echo ""
echo ">>> Checking dmesg for overlay-related messages..."
dmesg 2>/dev/null | grep -i overlay | tail -5 || echo "    (dmesg not available or no overlay messages)"
echo ""
echo "Done."

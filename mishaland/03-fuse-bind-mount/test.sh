#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

section() { echo -e "\n${CYAN}${BOLD}=== $1 ===${RESET}"; }
pass()    { echo -e "  ${GREEN}✓ $1${RESET}"; }
fail()    { echo -e "  ${RED}✗ $1${RESET}"; }
info()    { echo -e "  ${YELLOW}→ $1${RESET}"; }

# Strategy: mount FUSE at /mnt/fuse-home, create content THROUGH the FUSE
# mount at runtime (not baked into the image), then try to bind-mount local
# node_modules over the FUSE path. This exposes the overlay bypass: the bind
# resolves through Docker's overlayfs layers, not the live FUSE mount.
FUSE_MNT="/mnt/fuse-home"
FUSE_SOURCE="/srv/testuser-home"
PROJECT="$FUSE_MNT/project"
NM_FUSE="$PROJECT/node_modules"
NM_LOCAL="/var/local-node-modules"

verdict_ok=true
failures=()

record_fail() {
  verdict_ok=false
  failures+=("$1")
}

# ---------- 1. Start sshd ----------
section "1. Starting sshd"
/usr/sbin/sshd
sleep 0.5
if pgrep -x sshd >/dev/null; then
  pass "sshd running"
else
  fail "sshd failed to start"
  exit 1
fi

# ---------- 2. FUSE-mount via sshfs ----------
section "2. Mounting sshfs at $FUSE_MNT"

mkdir -p "$FUSE_MNT"

sshfs \
  -f \
  -o StrictHostKeyChecking=no \
  -o allow_other \
  -o IdentityFile=/home/testuser/.ssh/id_ed25519 \
  -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes \
  testuser@127.0.0.1:"$FUSE_SOURCE" \
  "$FUSE_MNT" > /dev/null 2>&1 &
sleep 2

if mountpoint -q "$FUSE_MNT"; then
  pass "$FUSE_MNT is a FUSE mountpoint"
else
  fail "$FUSE_MNT is NOT a mountpoint"
  exit 1
fi

# ---------- 3. Create content AT RUNTIME through FUSE ----------
# This is the key difference from the old test. Content created at runtime
# through FUSE lives on the FUSE backing store (FUSE_SOURCE), NOT in the
# overlay upperdir. This means the bind mount can't accidentally "work"
# by reading the overlay cache.
section "3. Creating project content THROUGH the FUSE mount (at runtime)"

mkdir -p "$NM_FUSE"
echo "runtime-fuse-content-$(date +%s)" > "$NM_FUSE/fuse-runtime.txt"
echo '{"name":"fuse-pkg"}' > "$NM_FUSE/package.json"

# Verify content is visible through FUSE
if [ -f "$NM_FUSE/fuse-runtime.txt" ]; then
  pass "Runtime content visible through FUSE"
  info "contents: $(cat "$NM_FUSE/fuse-runtime.txt")"
else
  fail "Runtime content NOT visible through FUSE"
  exit 1
fi

# Verify it's actually on the backing store
if [ -f "$FUSE_SOURCE/project/node_modules/fuse-runtime.txt" ]; then
  pass "Content confirmed on FUSE backing store"
else
  fail "Content NOT on backing store — FUSE write didn't land"
  exit 1
fi

# ---------- 4. Prepare local content for the bind ----------
section "4. Local node_modules content (to bind over FUSE)"
info "$NM_LOCAL contains: $(ls "$NM_LOCAL")"
info "local-marker.txt: $(cat "$NM_LOCAL/local-marker.txt")"

# ---------- 5. Attempt bind mount ----------
section "5. mount --bind $NM_LOCAL -> $NM_FUSE"

info "BEFORE bind:"
info "  $NM_FUSE: $(ls "$NM_FUSE" 2>&1)"
info "  $NM_LOCAL: $(ls "$NM_LOCAL" 2>&1)"

bind_exit=0
mount --bind "$NM_LOCAL" "$NM_FUSE" 2>&1 || bind_exit=$?

if [ "$bind_exit" -eq 0 ]; then
  pass "mount --bind returned exit code 0"
else
  fail "mount --bind returned exit code $bind_exit"
  record_fail "bind mount command failed"
fi

# ---------- 6. Check what's visible at NM_FUSE ----------
section "6. What's at $NM_FUSE after bind?"

info "AFTER bind:"
ls -la "$NM_FUSE" 2>&1 | while IFS= read -r line; do info "  $line"; done

has_local=false
has_fuse_runtime=false

if [ -f "$NM_FUSE/local-marker.txt" ]; then
  has_local=true
  pass "local-marker.txt visible (bind exposed local content)"
else
  fail "local-marker.txt NOT visible"
  record_fail "Local content not visible through bind"
fi

if [ -f "$NM_FUSE/fuse-runtime.txt" ]; then
  has_fuse_runtime=true
  fail "fuse-runtime.txt STILL visible (FUSE content leaking — bind ineffective)"
  record_fail "FUSE content leaking through bind"
else
  pass "fuse-runtime.txt hidden (bind mount covered FUSE content)"
fi

# ---------- 7. The real test: where do writes through the bind actually land? ----------
section "7. Write test: WHERE does data written through the bind actually go?"

SENTINEL="bind-write-test-$(date +%s).txt"
echo "written-through-bind-path" > "$NM_FUSE/$SENTINEL"

on_local=false
on_fuse_backing=false
on_overlay=false

if [ -f "$NM_LOCAL/$SENTINEL" ]; then
  on_local=true
  pass "Write landed on LOCAL disk ($NM_LOCAL/$SENTINEL)"
fi

if [ -f "$FUSE_SOURCE/project/node_modules/$SENTINEL" ]; then
  on_fuse_backing=true
  fail "Write landed on FUSE backing store"
fi

# Check if it went into overlay upperdir instead
# On Docker: the overlay upper is typically at /upper/upper or similar
# We can detect this by checking if the file exists at NM_FUSE but NOT
# at NM_LOCAL — meaning it went to overlay, not where we intended.
if [ -f "$NM_FUSE/$SENTINEL" ] && ! $on_local; then
  on_overlay=true
  fail "Write readable at $NM_FUSE but NOT on local disk — went to overlay upperdir"
  record_fail "Writes route to overlay upperdir, not local disk"
fi

if $on_local; then
  info "Write correctly routed to local disk"
else
  info "Write did NOT land on local disk"
fi

# ---------- 8. Prove the overlay bypass with /proc/mounts ----------
section "8. Mount table analysis"

info "Root filesystem:"
mount | grep -E "^overlay" | head -3 | while IFS= read -r line; do info "  $line"; done

info ""
info "FUSE mount:"
mount | grep fuse | while IFS= read -r line; do info "  $line"; done

info ""
info "Bind mount (from /proc/mounts):"
grep -E "node_modules" /proc/mounts 2>/dev/null | while IFS= read -r line; do
  info "  $line"
done || info "  (no node_modules entry — bind may have resolved through overlay)"

# Check if bind shows overlay device instead of local device
bind_device=$(grep "$NM_FUSE" /proc/mounts 2>/dev/null | awk '{print $1}' | head -1)
if [ -n "$bind_device" ]; then
  if echo "$bind_device" | grep -q overlay; then
    fail "Bind mount device is 'overlay' — resolved through container overlay, not local disk"
    record_fail "Bind device is overlay, not local filesystem"
  else
    info "Bind mount device: $bind_device"
  fi
else
  info "No explicit bind entry in /proc/mounts (kernel merged it into overlay)"
fi

# ---------- 9. Unmount bind, verify FUSE content survived ----------
section "9. After unmounting bind: is FUSE content still there?"

umount "$NM_FUSE" 2>/dev/null || true

if [ -f "$NM_FUSE/fuse-runtime.txt" ]; then
  pass "FUSE content restored after bind unmount"
  info "contents: $(cat "$NM_FUSE/fuse-runtime.txt")"
else
  fail "FUSE content LOST after bind unmount"
  record_fail "FUSE content lost after bind unmount"
fi

if [ -f "$NM_FUSE/$SENTINEL" ]; then
  fail "Write from bind path persisted on FUSE (unexpected — bind was supposed to route to local)"
  record_fail "Write leaked to FUSE after unmount"
else
  info "Write from bind path NOT on FUSE (confirms it went to overlay, not FUSE)"
fi

# ---------- 10. Verdict ----------
section "10. VERDICT"

echo ""
if $verdict_ok; then
  echo -e "${GREEN}${BOLD}  BIND MOUNT WORKED CORRECTLY${RESET}"
  echo ""
  echo -e "  Writes through the bind path landed on local disk as intended."
  echo -e "  This approach may work on this system — but is not guaranteed"
  echo -e "  across container runtimes."
else
  echo -e "${RED}${BOLD}  BIND MOUNT OVER FUSE IS BROKEN${RESET}"
  echo ""
  echo -e "  Failures:"
  for f in "${failures[@]}"; do
    echo -e "    ${RED}• $f${RESET}"
  done
  echo ""
  echo -e "  ${YELLOW}What happened:${RESET}"
  echo -e "    mount --bind returned 0, but the bind resolved through Docker's"
  echo -e "    overlay filesystem layers instead of the live FUSE mount."
  if $on_overlay; then
    echo -e "    Writes through the bind path went to the overlay upperdir —"
    echo -e "    NOT to local disk as intended. This means:"
    echo -e "      • node_modules writes would go to the ephemeral overlay"
    echo -e "      • Data is lost when the container restarts"
    echo -e "      • The local-disk performance benefit is an illusion"
  fi
  echo ""
  echo -e "  ${YELLOW}Why this matters for archil:${RESET}"
  echo -e "    You cannot reliably bind-mount local node_modules on top of"
  echo -e "    a FUSE-mounted path in containers. The kernel's overlay layer"
  echo -e "    intercepts the bind. Use symlinks or --virtual-store-dir instead."
fi

echo ""

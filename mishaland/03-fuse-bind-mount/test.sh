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

# We mount FUSE at /mnt/fuse-home (simulating archil mounted over ~).
# Then we try to bind-mount local node_modules on top of the FUSE path.
FUSE_MNT="/mnt/fuse-home"
FUSE_SOURCE="/srv/testuser-home"
NM_FUSE="$FUSE_MNT/project/node_modules"
NM_LOCAL="/var/local-node-modules"
WRITE_SENTINEL="write-test-$(date +%s).txt"

verdict_bind_ok=true

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
section "2. Mounting sshfs at $FUSE_MNT (simulating archil FUSE)"

mkdir -p "$FUSE_MNT"

# Use -f (foreground) + & because sshfs daemon mode hangs in containers.
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

# ---------- 3. Verify FUSE content ----------
section "3. Verifying FUSE-served content at $NM_FUSE"

if [ -f "$NM_FUSE/fuse-marker.txt" ]; then
  pass "fuse-marker.txt visible through FUSE"
  info "contents: $(cat "$NM_FUSE/fuse-marker.txt")"
else
  fail "fuse-marker.txt NOT visible — FUSE mount broken"
  exit 1
fi

# ---------- 4. Attempt bind mount ----------
section "4. Attempting: mount --bind $NM_LOCAL $NM_FUSE"

info "Before bind mount:"
info "  $NM_FUSE contains: $(ls "$NM_FUSE" 2>&1 || echo '(error listing)')"
info "  $NM_LOCAL contains: $(ls "$NM_LOCAL" 2>&1 || echo '(error listing)')"

bind_exit=0
mount --bind "$NM_LOCAL" "$NM_FUSE" 2>&1 || bind_exit=$?

# ---------- 5. Check exit code ----------
section "5. Bind mount exit code"
if [ "$bind_exit" -eq 0 ]; then
  pass "mount --bind returned exit code 0 (appeared to succeed)"
else
  fail "mount --bind returned exit code $bind_exit"
  verdict_bind_ok=false
fi

# ---------- 6. Check contents at mount point ----------
section "6. Listing $NM_FUSE after bind mount"

actual_contents=$(ls -la "$NM_FUSE" 2>&1 || echo "(error)")
echo "$actual_contents" | while IFS= read -r line; do info "$line"; done

has_local_marker=false
has_fuse_marker=false
is_empty=false

if [ -f "$NM_FUSE/local-marker.txt" ]; then
  has_local_marker=true
  pass "local-marker.txt IS visible (bind mount exposed local content)"
else
  fail "local-marker.txt NOT visible (bind mount did NOT expose local content)"
  verdict_bind_ok=false
fi

if [ -f "$NM_FUSE/fuse-marker.txt" ]; then
  has_fuse_marker=true
  fail "fuse-marker.txt STILL visible (FUSE content leaking through — bind mount ineffective)"
  verdict_bind_ok=false
else
  pass "fuse-marker.txt NOT visible (FUSE content correctly hidden by bind mount)"
fi

file_count=$(ls -1A "$NM_FUSE" 2>/dev/null | wc -l)
if [ "$file_count" -eq 0 ]; then
  is_empty=true
  fail "Directory is EMPTY — bind mount target shows nothing"
  verdict_bind_ok=false
fi

# ---------- 7. Write test ----------
section "7. Write test: creating $NM_FUSE/$WRITE_SENTINEL"

echo "written-through-bind" > "$NM_FUSE/$WRITE_SENTINEL" 2>&1 || true

info "Checking where the write actually landed..."

write_on_local=false
write_on_fuse=false
write_on_bind=false

if [ -f "$NM_LOCAL/$WRITE_SENTINEL" ]; then
  write_on_local=true
  pass "File landed on LOCAL disk ($NM_LOCAL/$WRITE_SENTINEL)"
  info "  contents: $(cat "$NM_LOCAL/$WRITE_SENTINEL")"
fi

if [ -f "$FUSE_SOURCE/project/node_modules/$WRITE_SENTINEL" ]; then
  write_on_fuse=true
  fail "File landed on FUSE backing store ($FUSE_SOURCE/project/node_modules/$WRITE_SENTINEL)"
  info "  contents: $(cat "$FUSE_SOURCE/project/node_modules/$WRITE_SENTINEL")"
  verdict_bind_ok=false
fi

if [ -f "$NM_FUSE/$WRITE_SENTINEL" ]; then
  write_on_bind=true
  info "File readable back through bind mount path"
else
  fail "File NOT readable back through $NM_FUSE (write silently lost)"
  verdict_bind_ok=false
fi

if ! $write_on_local && ! $write_on_fuse; then
  fail "File not found on either local disk or FUSE store — write was silently lost"
  verdict_bind_ok=false
fi

# ---------- 8. Mount table ----------
section "8. Mount table (relevant entries)"

mount | grep -E "(fuse|bind|overlay|$FUSE_MNT)" | while IFS= read -r line; do
  info "$line"
done

# Also check /proc/mounts for the bind
info ""
info "From /proc/mounts:"
grep -E "node_modules" /proc/mounts 2>/dev/null | while IFS= read -r line; do
  info "$line"
done || info "(no node_modules entry in /proc/mounts)"

# ---------- 9. Verdict ----------
section "9. VERDICT"

echo ""
if $verdict_bind_ok; then
  echo -e "${GREEN}${BOLD}  BIND MOUNT WORKED ON THIS SYSTEM${RESET}"
  echo ""
  echo -e "  On this system ($(uname -r)), bind-mounting over a FUSE path succeeded."
  echo -e "  However, in production Fly.io containers (which use overlayfs as"
  echo -e "  the root filesystem), we observed this failing: mount --bind returns 0"
  echo -e "  but the target is empty or shows the wrong content."
  echo ""
  echo -e "  ${YELLOW}The bind mount approach is unreliable across container runtimes.${RESET}"
else
  echo -e "${RED}${BOLD}  BIND MOUNT IS UNRELIABLE${RESET}"
  echo ""
  echo -e "  ${YELLOW}mount --bind returned 0 but the result is broken:${RESET}"
  $has_local_marker || echo -e "    - Local content NOT visible at mount point"
  $has_fuse_marker  && echo -e "    - FUSE content still leaking through"
  $is_empty         && echo -e "    - Mount point is empty (neither local nor FUSE content)"
  $write_on_fuse    && echo -e "    - Writes went to FUSE backing store, not local disk"
  ! $write_on_local && ! $write_on_fuse && echo -e "    - Writes were silently lost"
  echo ""
  echo -e "  ${YELLOW}Why this matters:${RESET}"
  echo -e "    When the root filesystem is an overlay (Docker/Fly containers),"
  echo -e "    bind-mounting on top of a FUSE mount may silently fail."
  echo -e "    The kernel resolves the bind through the overlay's upper/lower"
  echo -e "    layers rather than the live FUSE mount, so:"
  echo -e "      - The target may appear empty"
  echo -e "      - Writes may go to the overlay upper dir (not local disk)"
  echo -e "      - The FUSE content may still be visible"
  echo -e ""
  echo -e "  ${YELLOW}Implication for pnpm + archil:${RESET}"
  echo -e "    You cannot reliably bind-mount local node_modules on top of"
  echo -e "    a FUSE-mounted home directory to avoid FUSE I/O overhead."
  echo -e "    Instead, use symlinks, PNPM_HOME, or --virtual-store-dir"
  echo -e "    to redirect pnpm to local disk."
fi

echo ""

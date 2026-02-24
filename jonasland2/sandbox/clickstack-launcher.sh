#!/usr/bin/env sh
set -eu

ROOT="/opt/clickstack-root"

mkdir -p "$ROOT/dev" "$ROOT/proc" "$ROOT/sys"

if ! mountpoint -q "$ROOT/dev"; then
  mount --bind /dev "$ROOT/dev"
fi

if ! mountpoint -q "$ROOT/proc"; then
  mount -t proc proc "$ROOT/proc"
fi

if ! mountpoint -q "$ROOT/sys"; then
  mount --bind /sys "$ROOT/sys"
fi

# ClickStack startup scripts require localhost host resolution and local DNS.
printf "127.0.0.1 localhost\n127.0.0.1 ch-server\n127.0.0.1 db\n" > "$ROOT/etc/hosts"
printf "nameserver 127.0.0.1\n" > "$ROOT/etc/resolv.conf"

cleanup() {
  umount "$ROOT/dev" 2>/dev/null || true
  umount "$ROOT/proc" 2>/dev/null || true
  umount "$ROOT/sys" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

exec chroot "$ROOT" /bin/sh -lc "cd /app && exec /etc/local/entry.sh"

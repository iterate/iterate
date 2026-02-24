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

# Apply low-memory defaults on every start so local sandboxes stay predictable.
mkdir -p "$ROOT/etc/clickhouse-server/config.d" "$ROOT/etc/clickhouse-server/users.d"

cat > "$ROOT/etc/clickhouse-server/config.d/zz-jonasland2-memory.xml" <<'EOF'
<clickhouse>
  <max_server_memory_usage>2147483648</max_server_memory_usage>
  <max_server_memory_usage_to_ram_ratio>0.5</max_server_memory_usage_to_ram_ratio>
</clickhouse>
EOF

cat > "$ROOT/etc/clickhouse-server/users.d/zz-jonasland2-memory.xml" <<'EOF'
<clickhouse>
  <profiles>
    <default>
      <max_memory_usage>1073741824</max_memory_usage>
      <max_memory_usage_for_user>2147483648</max_memory_usage_for_user>
      <max_memory_usage_for_all_queries>3221225472</max_memory_usage_for_all_queries>
      <max_bytes_before_external_group_by>268435456</max_bytes_before_external_group_by>
      <max_bytes_before_external_sort>268435456</max_bytes_before_external_sort>
      <max_bytes_in_join>134217728</max_bytes_in_join>
      <max_rows_in_join>1000000</max_rows_in_join>
      <join_algorithm>auto</join_algorithm>
      <max_threads>4</max_threads>
      <max_insert_threads>2</max_insert_threads>
      <use_uncompressed_cache>0</use_uncompressed_cache>
    </default>
  </profiles>
</clickhouse>
EOF

cleanup() {
  umount "$ROOT/dev" 2>/dev/null || true
  umount "$ROOT/proc" 2>/dev/null || true
  umount "$ROOT/sys" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

exec chroot "$ROOT" /bin/sh -lc "cd /app && exec /etc/local/entry.sh"

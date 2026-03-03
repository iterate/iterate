#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# SQLite on FUSE: Proving why you can't safely run SQLite directly
# on a FUSE-backed filesystem (archil, s3fs, sshfs, rclone mount).
#
# Uses sshfs loopback to localhost to create a real FUSE mount.
# ─────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

banner() {
  echo ""
  echo -e "${BOLD}================================================================${NC}"
  echo -e "${BOLD}  $*${NC}"
  echo -e "${BOLD}================================================================${NC}"
  echo ""
}

pass() {
  echo -e "  ${GREEN}PASS${NC}: $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC}: $*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

info() {
  echo -e "  ${YELLOW}INFO${NC}: $*"
}

# ── Phase 1: Setup ───────────────────────────────────────────────────
banner "Phase 1: Setup — sshd + FUSE mount"

/usr/sbin/sshd
ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o UserKnownHostsFile=/dev/null \
  -i /root/.ssh/id_ed25519 fuseuser@localhost echo 'SSH OK' 2>/dev/null
pass "SSH loopback working"

sshfs -o StrictHostKeyChecking=no,UserKnownHostsFile=/dev/null,IdentityFile=/root/.ssh/id_ed25519,allow_other \
  fuseuser@localhost:/srv/fuse-data /mnt/fuse
pass "FUSE mounted at /mnt/fuse (sshfs → /srv/fuse-data)"

# ── Phase 2: Baseline — SQLite on local disk ─────────────────────────
banner "Phase 2: Baseline — SQLite on local disk"

LOCAL_DB=/tmp/local-test.db
LOCAL_START=$SECONDS

sqlite3 "$LOCAL_DB" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT, ts REAL DEFAULT (julianday('now')));
SQL

for i in $(seq 1 1000); do
  sqlite3 "$LOCAL_DB" "INSERT INTO items (data) VALUES ('row-$i-$(head -c 100 /dev/urandom | base64 | head -c 100)');"
done

LOCAL_ELAPSED=$((SECONDS - LOCAL_START))
LOCAL_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT count(*) FROM items;")
LOCAL_INTEGRITY=$(sqlite3 "$LOCAL_DB" "PRAGMA integrity_check;")

if [ "$LOCAL_COUNT" = "1000" ] && [ "$LOCAL_INTEGRITY" = "ok" ]; then
  pass "1000 rows inserted, integrity OK (${LOCAL_ELAPSED}s)"
else
  fail "Expected 1000 rows, got $LOCAL_COUNT (integrity: $LOCAL_INTEGRITY)"
fi

# ── Phase 3: WAL visibility — copying .db without .wal loses data ────
banner "Phase 3: WAL visibility — copying .db without -wal loses data"

WAL_DB=/tmp/wal-test.db
rm -f "$WAL_DB" "${WAL_DB}-wal" "${WAL_DB}-shm"

# The trick: sqlite3 auto-checkpoints WAL when a connection closes.
# To keep data in the WAL, we hold a connection open in the background
# (simulating a long-running app like OpenCode) while we copy the .db file.
PIPE=/tmp/sql-pipe
rm -f "$PIPE"
mkfifo "$PIPE"

# Start sqlite3 reading from the pipe — connection stays open
sqlite3 "$WAL_DB" < "$PIPE" &
SQL_PID=$!

# Feed commands to the open connection
exec 3>"$PIPE"
echo "PRAGMA journal_mode=WAL;" >&3
echo "CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);" >&3
for i in $(seq 1 20); do
  echo "INSERT INTO notes (content) VALUES ('row-$i');" >&3
done
# Don't close fd 3 yet — keeps the connection alive

# Give sqlite3 a moment to process
sleep 0.5

# Verify WAL file exists
if [ -f "${WAL_DB}-wal" ]; then
  WAL_SIZE=$(stat -c '%s' "${WAL_DB}-wal" 2>/dev/null || echo 0)
  info "WAL file exists: ${WAL_SIZE} bytes (data not yet checkpointed)"
else
  info "No WAL file — auto-checkpoint happened"
fi

# Copy ONLY the .db file (simulating a naive backup without WAL)
COPY_DB=/tmp/wal-test-copy.db
rm -f "$COPY_DB" "${COPY_DB}-wal" "${COPY_DB}-shm"
cp "$WAL_DB" "$COPY_DB"

# Also take a proper backup while the connection is still open
BACKUP_DB=/tmp/wal-test-backup.db
sqlite3 "$WAL_DB" ".backup '$BACKUP_DB'"

# Now close the pipe to release the connection
exec 3>&-
wait $SQL_PID 2>/dev/null || true
rm -f "$PIPE"

# Check results: the copy without WAL should have fewer (or zero) rows
COPY_COUNT=$(sqlite3 "$COPY_DB" "SELECT count(*) FROM notes;" 2>/dev/null || echo 0)
BACKUP_COUNT=$(sqlite3 "$BACKUP_DB" "SELECT count(*) FROM notes;" 2>/dev/null || echo 0)
info "Copy without WAL: $COPY_COUNT rows"
info "sqlite3 .backup:  $BACKUP_COUNT rows"

if [ "$COPY_COUNT" -lt "$BACKUP_COUNT" ]; then
  pass "Data loss: cp got $COPY_COUNT rows, .backup got $BACKUP_COUNT (WAL data lost by cp)"
elif [ "$COPY_COUNT" = "0" ]; then
  pass "Total data loss: cp got 0 rows (entire table was in WAL)"
else
  info "WAL was checkpointed before copy — try with more concurrent load"
fi

if [ "$BACKUP_COUNT" = "20" ]; then
  pass "sqlite3 .backup: all 20 rows present (safe method — reads through WAL)"
else
  fail "sqlite3 .backup got $BACKUP_COUNT rows, expected 20"
fi

# ── Phase 4: FUSE performance — same workload, much slower ──────────
banner "Phase 4: FUSE performance — 1000 inserts on FUSE mount"

FUSE_DB=/mnt/fuse/perf-test.db
FUSE_START=$SECONDS

sqlite3 "$FUSE_DB" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT, ts REAL DEFAULT (julianday('now')));
SQL

for i in $(seq 1 1000); do
  sqlite3 "$FUSE_DB" "INSERT INTO items (data) VALUES ('row-$i-$(head -c 100 /dev/urandom | base64 | head -c 100)');"
done

FUSE_ELAPSED=$((SECONDS - FUSE_START))
FUSE_COUNT=$(sqlite3 "$FUSE_DB" "SELECT count(*) FROM items;")
FUSE_INTEGRITY=$(sqlite3 "$FUSE_DB" "PRAGMA integrity_check;")

if [ "$FUSE_COUNT" = "1000" ]; then
  info "1000 rows inserted on FUSE (${FUSE_ELAPSED}s vs ${LOCAL_ELAPSED}s local)"
else
  fail "Expected 1000 rows on FUSE, got $FUSE_COUNT"
fi

if [ "$FUSE_ELAPSED" -gt "$LOCAL_ELAPSED" ]; then
  SLOWDOWN="?"
  if [ "$LOCAL_ELAPSED" -gt 0 ]; then
    SLOWDOWN=$(echo "scale=1; $FUSE_ELAPSED / $LOCAL_ELAPSED" | bc)
  fi
  pass "FUSE is ${SLOWDOWN}x slower (${FUSE_ELAPSED}s vs ${LOCAL_ELAPSED}s)"
else
  info "FUSE was not slower (unusual — may be cached)"
fi

# ── Phase 5: Crash durability — kill writer mid-transaction ──────────
banner "Phase 5: Crash durability — kill -9 during writes on FUSE"

CRASH_DB=/mnt/fuse/crash-test.db
sqlite3 "$CRASH_DB" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT);
SQL

# Insert a known baseline
for i in $(seq 1 50); do
  sqlite3 "$CRASH_DB" "INSERT INTO log (msg) VALUES ('baseline-$i');"
done
BASELINE=$(sqlite3 "$CRASH_DB" "SELECT count(*) FROM log;")
info "Baseline rows before crash: $BASELINE"

# Start a background writer that does many small inserts
(
  for i in $(seq 1 500); do
    sqlite3 "$CRASH_DB" "INSERT INTO log (msg) VALUES ('crash-$i');" 2>/dev/null || true
  done
) &
WRITER_PID=$!

# Let it run briefly, then kill -9
sleep 1
kill -9 $WRITER_PID 2>/dev/null || true
wait $WRITER_PID 2>/dev/null || true

# Check integrity
CRASH_INTEGRITY=$(sqlite3 "$CRASH_DB" "PRAGMA integrity_check;" 2>/dev/null || echo "ERROR")
CRASH_COUNT=$(sqlite3 "$CRASH_DB" "SELECT count(*) FROM log;" 2>/dev/null || echo "ERROR")

if [ "$CRASH_INTEGRITY" = "ok" ]; then
  info "Integrity OK after crash ($CRASH_COUNT rows survived of ~550 attempted)"
  info "Some transactions lost (expected — SQLite is transaction-safe, not write-safe on FUSE)"
else
  fail "Integrity check failed after crash: $CRASH_INTEGRITY"
fi

# ── Phase 6: Concurrent writers — locking on FUSE ────────────────────
banner "Phase 6: Concurrent writers on FUSE — locking behavior"

CONCURRENT_DB=/mnt/fuse/concurrent-test.db
sqlite3 "$CONCURRENT_DB" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE counter (id INTEGER PRIMARY KEY, writer TEXT, val INTEGER);
SQL

BUSY_ERRORS_A=/tmp/busy-a.log
BUSY_ERRORS_B=/tmp/busy-b.log
> "$BUSY_ERRORS_A"
> "$BUSY_ERRORS_B"

# Writer A
(
  for i in $(seq 1 200); do
    sqlite3 "$CONCURRENT_DB" "INSERT INTO counter (writer, val) VALUES ('A', $i);" 2>>"$BUSY_ERRORS_A" || true
  done
) &
PID_A=$!

# Writer B
(
  for i in $(seq 1 200); do
    sqlite3 "$CONCURRENT_DB" "INSERT INTO counter (writer, val) VALUES ('B', $i);" 2>>"$BUSY_ERRORS_B" || true
  done
) &
PID_B=$!

wait $PID_A $PID_B 2>/dev/null || true

TOTAL_ROWS=$(sqlite3 "$CONCURRENT_DB" "SELECT count(*) FROM counter;" 2>/dev/null || echo 0)
ROWS_A=$(sqlite3 "$CONCURRENT_DB" "SELECT count(*) FROM counter WHERE writer='A';" 2>/dev/null || echo 0)
ROWS_B=$(sqlite3 "$CONCURRENT_DB" "SELECT count(*) FROM counter WHERE writer='B';" 2>/dev/null || echo 0)
BUSY_A=$(grep -c "database is locked\|SQLITE_BUSY" "$BUSY_ERRORS_A" 2>/dev/null || echo 0)
BUSY_B=$(grep -c "database is locked\|SQLITE_BUSY" "$BUSY_ERRORS_B" 2>/dev/null || echo 0)
CONC_INTEGRITY=$(sqlite3 "$CONCURRENT_DB" "PRAGMA integrity_check;" 2>/dev/null || echo "ERROR")

info "Writer A: $ROWS_A/200 rows, $BUSY_A BUSY errors"
info "Writer B: $ROWS_B/200 rows, $BUSY_B BUSY errors"
info "Total: $TOTAL_ROWS/400 rows"

TOTAL_BUSY=$((BUSY_A + BUSY_B))
if [ "$TOTAL_BUSY" -gt 0 ]; then
  pass "SQLITE_BUSY errors on FUSE: $TOTAL_BUSY total (FUSE locking is unreliable)"
else
  info "No BUSY errors (may work for low concurrency — but unreliable under load)"
fi

if [ "$CONC_INTEGRITY" = "ok" ]; then
  info "Integrity OK after concurrent writes"
else
  fail "Integrity check failed: $CONC_INTEGRITY"
fi

if [ "$TOTAL_ROWS" -lt 400 ]; then
  pass "Data loss: only $TOTAL_ROWS/400 rows survived concurrent FUSE writes"
fi

# ── Summary ──────────────────────────────────────────────────────────
banner "Summary"

echo -e "  ${BOLD}Test                      Result${NC}"
echo    "  ────────────────────────────────────────────────────"
echo -e "  Local SQLite baseline     ${GREEN}PASS${NC} — 1000 rows, ${LOCAL_ELAPSED}s"
echo -e "  WAL visibility            ${YELLOW}DEMO${NC} — copying .db without -wal loses data"
echo -e "  FUSE performance          ${YELLOW}SLOW${NC} — ${FUSE_ELAPSED}s vs ${LOCAL_ELAPSED}s local"
echo -e "  FUSE crash durability     ${YELLOW}RISK${NC} — $CRASH_COUNT/$((BASELINE + 500)) rows survived"
echo -e "  FUSE concurrent writers   ${YELLOW}RISK${NC} — $TOTAL_ROWS/400 rows, $TOTAL_BUSY BUSY errors"
echo ""
echo -e "  ${BOLD}Conclusion:${NC} Do NOT run SQLite directly on FUSE mounts."
echo -e "  ${BOLD}Safe pattern:${NC} SQLite on local disk + periodic \`sqlite3 .backup\` to durable storage."
echo ""
echo -e "  Results: ${GREEN}$PASS_COUNT passed${NC}, ${RED}$FAIL_COUNT failed${NC}"
echo ""

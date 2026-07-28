import { settleByDeadline } from "../../execution-deadline.ts";

const SANDBOX_PROCESS_GROUP_TERM_GRACE_SECONDS = "0.5";
const SANDBOX_PROCESS_GROUP_KILL_ATTEMPTS = 20;
const SANDBOX_PROCESS_GROUP_POLL_SECONDS = "0.05";
const SANDBOX_EXEC_ADMISSION_CANCELLATION_POLL_ATTEMPTS = 100;

/**
 * Shell executed in a fresh sessionless process group to terminate a DIFFERENT
 * group. `ps`, rather than the group leader alone, is the source of truth: a
 * cooperative leader may exit on TERM while one of its descendants ignores
 * the signal. Zombies are already terminated and cannot execute code, so they
 * do not keep cleanup open while PID 1 gets a chance to reap them.
 */
function sandboxProcessGroupCleanupLines(): string[] {
  return [
    "group_has_active_processes() {",
    "  ps -eo pgid=,stat= | awk -v wanted=\"$pgid\" '$1 == wanted && $2 !~ /^Z/ { found=1 } END { exit(found ? 0 : 1) }'",
    "}",
    "wait_for_group_exit() {",
    "  attempts=$1",
    "  while group_has_active_processes; do",
    '    if test "$attempts" -le 0; then return 1; fi',
    `    sleep ${SANDBOX_PROCESS_GROUP_POLL_SECONDS}`,
    "    attempts=$((attempts - 1))",
    "  done",
    "}",
    'kill -TERM -- -"$pgid" 2>/dev/null || true',
    `sleep ${SANDBOX_PROCESS_GROUP_TERM_GRACE_SECONDS}`,
    "if ! group_has_active_processes; then exit 0; fi",
    'kill -KILL -- -"$pgid" 2>/dev/null || true',
    `if wait_for_group_exit ${SANDBOX_PROCESS_GROUP_KILL_ATTEMPTS}; then exit 0; fi`,
    "printf 'sandbox process group %s survived TERM and KILL\\n' \"$pgid\" >&2",
    "ps -eo pid=,ppid=,pgid=,stat=,args= | awk -v wanted=\"$pgid\" '$3 == wanted { print }' >&2",
    "exit 70",
  ];
}

export function sandboxProcessGroupCleanupCommand(processGroupId: number): string {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error(`Invalid sandbox process-group id: ${String(processGroupId)}`);
  }

  return ["set -u", `pgid=${processGroupId}`, ...sandboxProcessGroupCleanupLines()].join("\n");
}

/**
 * Prefix a timed user command with a one-use admission guard. If the caller's
 * deadline expires before the SDK reports the process group, a separate
 * command creates a container-local `cancelled` tombstone and then reads
 * `process-group`. Every race is safe:
 *
 * - cancellation first: this wrapper exits before the user command;
 * - process-group first: cancellation terminates exactly that group;
 * - delayed admission: the tombstone remains for the wrapper to observe.
 */
export function guardSandboxExecAdmission(command: string, guardDirectory: string): string {
  return [
    `__iterate_exec_guard=${shellSingleQuote(guardDirectory)}`,
    'mkdir -p "$__iterate_exec_guard"',
    '__iterate_exec_pgid=$(ps -o pgid= -p "$$" | tr -d "[:space:]")',
    'case "$__iterate_exec_pgid" in ""|*[!0-9]*) printf "invalid sandbox process group: %s\\n" "$__iterate_exec_pgid" >&2; exit 70 ;; esac',
    'printf "%s\\n" "$__iterate_exec_pgid" > "$__iterate_exec_guard/process-group"',
    'if test -e "$__iterate_exec_guard/cancelled"; then exit 125; fi',
    "trap 'rm -rf \"$__iterate_exec_guard\"' EXIT",
    command,
  ].join("\n");
}

/**
 * Install the admission tombstone, wait briefly for a concurrently-starting
 * wrapper to publish its process group, then apply the normal targeted
 * TERM/KILL proof. A missing group is success: either admission has not
 * happened yet (the container-local tombstone will reject it) or the command
 * already completed without its start event reaching this isolate.
 */
export function cancelSandboxExecAdmissionCommand(
  guardDirectory: string,
  pollAttempts = SANDBOX_EXEC_ADMISSION_CANCELLATION_POLL_ATTEMPTS,
): string {
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 0) {
    throw new Error(`Invalid sandbox admission cancellation poll attempts: ${pollAttempts}`);
  }
  return [
    "set -u",
    `guard_dir=${shellSingleQuote(guardDirectory)}`,
    'mkdir -p "$guard_dir"',
    ': > "$guard_dir/cancelled"',
    `attempts=${pollAttempts}`,
    'while ! test -s "$guard_dir/process-group"; do',
    '  if test "$attempts" -le 0; then exit 0; fi',
    `  sleep ${SANDBOX_PROCESS_GROUP_POLL_SECONDS}`,
    "  attempts=$((attempts - 1))",
    "done",
    'pgid=$(tr -d "[:space:]" < "$guard_dir/process-group")',
    'case "$pgid" in ""|*[!0-9]*) printf "invalid guarded sandbox process group: %s\\n" "$pgid" >&2; exit 70 ;; esac',
    'if test "$pgid" -le 1; then printf "invalid guarded sandbox process group: %s\\n" "$pgid" >&2; exit 70; fi',
    ...sandboxProcessGroupCleanupLines(),
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Bound the whole command-admission path: acquiring the SDK stream and
 * receiving its first `start` event. The command's completion is part of the
 * race because a stream that ends before announcing its process group cannot
 * be cleaned up with the normal targeted timeout path.
 *
 * `settleByDeadline` keeps observing a late rejection after the caller moves
 * to its cancellation path, so a delayed transport failure cannot become an
 * unhandled rejection.
 */
export async function waitForSandboxExecAdmission({
  admission,
  deadlineAt,
  now = Date.now,
}: {
  admission: Promise<number>;
  deadlineAt: number;
  now?: () => number;
}): Promise<{ kind: "started"; processGroupId: number } | { kind: "deadline" }> {
  const outcome = await settleByDeadline(admission, deadlineAt, now);
  switch (outcome.status) {
    case "fulfilled":
      return { kind: "started", processGroupId: outcome.value };
    case "rejected":
      throw outcome.error;
    case "deadline":
      return { kind: "deadline" };
  }
}

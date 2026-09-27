import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, test } from "vitest";

const projectDir = join(import.meta.dirname, "..", "..");
const bash = which("bash");

test("non-gh commands pass through untouched", () => {
  expect(runHook("pnpm test")).toMatchObject({ status: 0, stderr: "" });
  expect(runHook("git push origin my-branch")).toMatchObject({ status: 0, stderr: "" });
});

test("read-only gh commands pass through — PR monitoring must not be nagged", () => {
  expect(runHook("gh pr view 123 --json title,body")).toMatchObject({ status: 0 });
  expect(runHook("gh pr checks 123 --watch")).toMatchObject({ status: 0 });
  expect(runHook("gh pr list --state open")).toMatchObject({ status: 0 });
  expect(
    runHook(
      `gh api repos/iterate/iterate/pulls/123 -H "Accept: application/vnd.github.html+json" --jq .body_html`,
    ),
  ).toMatchObject({ status: 0 });
});

test("gh pr create without the ack hash is blocked, and the deny message is the guidance doc", () => {
  const result = runHook(`gh pr create --draft --title "hello" --body "world"`);
  expect(result).toMatchObject({ status: 2 });
  const guidance = readFileSync(join(projectDir, "docs", "pull-requests.md"), "utf8");
  expect(result.stderr).toContain(guidance);
  expect(result.stderr).toContain(`PR_GUIDANCE_HASH=${currentHash()}`);
});

test("gh pr edit and merge and the REST PATCH escape hatch are blocked too", () => {
  expect(runHook("gh pr edit 123 --body-file body.md")).toMatchObject({ status: 2 });
  expect(runHook("gh pr merge 123 --squash")).toMatchObject({ status: 2 });
  expect(
    runHook("gh api -X PATCH repos/iterate/iterate/pulls/123 --input payload.json"),
  ).toMatchObject({ status: 2 });
});

test("following the deny message's own instructions unblocks the command", () => {
  const denied = runHook(`gh pr create --title "hello"`);
  const ackHash = /PR_GUIDANCE_HASH=([0-9a-f]{8})/.exec(denied.stderr)?.[1];
  expect(ackHash).toBe(currentHash());
  expect(runHook(`PR_GUIDANCE_HASH=${ackHash} gh pr create --title "hello"`)).toMatchObject({
    status: 0,
    stderr: "",
  });
});

test("a stale hash — the doc changed since it was read — is blocked again", () => {
  expect(runHook(`PR_GUIDANCE_HASH=00000000 gh pr create --title "hello"`)).toMatchObject({
    status: 2,
  });
});

// The tests above use this machine's PATH, so they cover only the hash tool it has. These cover
// each case on every machine.
test.for(["sha1sum", "shasum"])("with only %s on the PATH, the gate blocks and acks", (tool) => {
  using bin = pathWith([tool]);
  const denied = runHook(`gh pr create --title "hello"`, bin.path);
  expect(denied).toMatchObject({ status: 2 });
  expect(denied.stderr).toContain(`PR_GUIDANCE_HASH=${currentHash()}`);
  expect(
    runHook(`PR_GUIDANCE_HASH=${currentHash()} gh pr create --title "hello"`, bin.path),
  ).toMatchObject({ status: 0, stderr: "" });
});

test("with no hash tool, a gated command is blocked rather than let through", () => {
  using bin = pathWith([]);
  expect(runHook(`gh pr create --title "hello"`, bin.path)).toMatchObject({
    status: 2,
    stderr: "pr-guidance-gate: need shasum or sha1sum to hash docs/pull-requests.md\n",
  });
  expect(runHook("pnpm test", bin.path)).toMatchObject({ status: 0, stderr: "" });
});

// spawn the real hook script the way Claude Code does: PreToolUse payload on stdin,
// CLAUDE_PROJECT_DIR in the environment
function runHook(command: string, path = process.env.PATH) {
  const payload = JSON.stringify({
    session_id: "test-session",
    tool_name: "Bash",
    tool_input: { command, description: "test command" },
  });
  const result = spawnSync(bash, [join(import.meta.dirname, "pr-guidance-gate.sh")], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, PATH: path },
  });
  return { status: result.status, stderr: result.stderr };
}

// first 8 hex chars of docs/pull-requests.md's SHA-1 — the ack token the hook expects
function currentHash() {
  const doc = readFileSync(join(projectDir, "docs", "pull-requests.md"));
  return createHash("sha1").update(doc).digest("hex").slice(0, 8);
}

// A PATH directory holding only the hook's external commands: `cat`, `cut` and the given hash
// tools. Each hash tool runs whichever SHA-1 tool this machine has (macOS ships `shasum`, Arch
// Linux only `sha1sum`), so both of the hook's branches hash for real on every machine.
function pathWith(hashTools: string[]) {
  const bin = temporaryDirectory();
  for (const tool of ["cat", "cut"]) symlinkSync(which(tool), join(bin.path, tool));
  const sha1 = which("sha1sum", "shasum");
  for (const tool of hashTools) {
    writeFileSync(join(bin.path, tool), `#!${bash}\nexec ${sha1} "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

// the path of the first of `tools` on this machine's PATH
function which(...tools: string[]) {
  for (const tool of tools) {
    const found = spawnSync("bash", ["-c", 'command -v "$1"', "which", tool], {
      encoding: "utf8",
    }).stdout.trim();
    if (found) return found;
  }
  throw new Error(`none of ${tools.join(", ")} is on the PATH`);
}

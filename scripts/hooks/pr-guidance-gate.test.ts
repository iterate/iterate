import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const projectDir = join(import.meta.dirname, "..", "..");

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

// spawn the real hook script the way Claude Code does: PreToolUse payload on stdin,
// CLAUDE_PROJECT_DIR in the environment
function runHook(command: string) {
  const payload = JSON.stringify({
    session_id: "test-session",
    tool_name: "Bash",
    tool_input: { command, description: "test command" },
  });
  const result = spawnSync("bash", [join(import.meta.dirname, "pr-guidance-gate.sh")], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { status: result.status, stderr: result.stderr };
}

// first 8 hex chars of `shasum docs/pull-requests.md` — the ack token the hook expects
function currentHash() {
  const doc = readFileSync(join(projectDir, "docs", "pull-requests.md"));
  return createHash("sha1").update(doc).digest("hex").slice(0, 8);
}

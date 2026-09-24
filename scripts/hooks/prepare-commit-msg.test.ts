import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

const projectDir = join(import.meta.dirname, "..", "..");
const agentMarkers = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "OPENCODE",
  "OPENCODE_SESSION",
  "AGENT",
];
const amendBlocked = "ERROR: AI agents are not allowed to use --amend (rewrites history)\n";

test.each([
  { CLAUDE_CODE_CHILD_SESSION: "1" },
  { OPENCODE: "1" },
  { OPENCODE_SESSION: "ses_1" },
  { AGENT: "1" },
])("an agent (%o) cannot amend, with or without -m", (marker) => {
  using repo = scratchRepo(marker);
  expect(repo.git("commit", "--amend", "--no-edit")).toMatchObject({
    status: 1,
    stdout: expect.stringContaining(amendBlocked),
  });
  expect(repo.git("commit", "--amend", "-m", "rewritten")).toMatchObject({
    status: 1,
    stdout: expect.stringContaining(amendBlocked),
  });
  expect(repo.git("log", "--format=%s")).toMatchObject({ stdout: "first\n" });
});

test("an agent can commit, reuse a message with -C, and rebase", () => {
  using repo = scratchRepo({ CLAUDE_CODE_CHILD_SESSION: "1" });
  expect(repo.git("commit", "--allow-empty", "-m", "second")).toMatchObject({ status: 0 });
  const second = repo.git("rev-parse", "HEAD").stdout.trim();
  expect(repo.git("commit", "--allow-empty", "-C", second)).toMatchObject({ status: 0 });
  repo.git("switch", "-c", "feature", "HEAD~2");
  repo.write("feature.txt", "feature\n");
  repo.git("add", "feature.txt");
  repo.git("commit", "-m", "feature");
  expect(repo.git("rebase", "main")).toMatchObject({ status: 0 });
  expect(repo.git("log", "--format=%s")).toMatchObject({
    stdout: "feature\nsecond\nsecond\nfirst\n",
  });
});

// A shell above the commit may mention amending in unrelated text; only the committing git counts.
test("an agent's commit is not blocked by --amend in its shell's command line", () => {
  using repo = scratchRepo({ CLAUDE_CODE_CHILD_SESSION: "1" });
  expect(
    repo.shell('echo "never git commit --amend" && git commit --allow-empty -m second'),
  ).toMatchObject({ status: 0 });
  expect(repo.git("log", "--format=%s")).toMatchObject({ stdout: "second\nfirst\n" });
});

// ps prints git's arguments joined by spaces, so the message given to -m is indistinguishable from
// options after it; only options before the first message-taking option count.
test("an agent's commit message may mention --amend", () => {
  using repo = scratchRepo({ CLAUDE_CODE_CHILD_SESSION: "1" });
  repo.write("file.txt", "one\n");
  repo.git("add", "file.txt");
  expect(repo.git("commit", "-m", "the hook blocks only --amend now")).toMatchObject({ status: 0 });
  repo.write("file.txt", "two\n");
  expect(repo.git("commit", "-am", "no --amend here")).toMatchObject({ status: 0 });
  expect(
    repo.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "--message=a --amend b"),
  ).toMatchObject({ status: 0 });
  expect(repo.git("log", "--format=%s")).toMatchObject({
    stdout: "a --amend b\nno --amend here\nthe hook blocks only --amend now\nfirst\n",
  });
});

test("an agent cannot amend through global options or an abbreviated --amend", () => {
  using repo = scratchRepo({ AGENT: "1" });
  for (const args of [
    ["-c", "commit.gpgsign=false", "commit", "--amend", "-m", "rewritten"],
    ["commit", "-a", "--amen", "-m", "rewritten"],
  ]) {
    expect(repo.git(...args), args.join(" ")).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(amendBlocked),
    });
  }
  expect(repo.git("log", "--format=%s")).toMatchObject({ stdout: "first\n" });
});

// CLAUDECODE alone is what Claude Code's IDE extensions leave in the integrated terminal a person
// types into (https://code.claude.com/docs/en/env-vars), so it does not mark an agent.
test("a person can amend, including in an IDE terminal that carries CLAUDECODE", () => {
  using repo = scratchRepo({ CLAUDECODE: "1" });
  expect(repo.git("commit", "--amend", "-m", "reworded")).toMatchObject({ status: 0 });
  expect(repo.git("log", "--format=%s")).toMatchObject({ stdout: "reworded\n" });
});

test.each([{}, { CLAUDE_CODE_CHILD_SESSION: "1" }, { AGENT: "1" }])(
  "the pre-commit hook only formats the staged files, for people and agents alike (%o)",
  (marker) => {
    expect(lintStagedCommands(marker)).toEqual(["oxfmt --no-error-on-unmatched-pattern"]);
  },
);

// A one-commit repo on `main` whose only hook is the real prepare-commit-msg, next to the agent
// detector it loads from the same path as in this repo. The environment keeps none of this
// process's agent markers or GIT_* variables.
function scratchRepo(marker: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "prepare-commit-msg-"));
  mkdirSync(join(dir, "hooks"));
  copyFileSync(
    join(projectDir, ".husky/prepare-commit-msg"),
    join(dir, "hooks/prepare-commit-msg"),
  );
  mkdirSync(join(dir, "packages/cli/src"), { recursive: true });
  copyFileSync(
    join(projectDir, "packages/cli/src/coding-agent.ts"),
    join(dir, "packages/cli/src/coding-agent.ts"),
  );
  writeFileSync(join(dir, ".gitignore"), "hooks/\npackages/\n");
  const env = { ...cleanEnv(), ...marker };
  const shell = (command: string) => {
    const result = spawnSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout + result.stderr };
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout + result.stderr };
  };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["config", "core.hooksPath", "hooks"],
    ["add", ".gitignore"],
    ["commit", "-q", "-m", "first"],
  ]) {
    expect(git(...args), `git ${args.join(" ")}`).toMatchObject({ status: 0 });
  }
  return {
    git,
    shell,
    write: (file: string, text: string) => writeFileSync(join(dir, file), text),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function lintStagedCommands(marker: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["-e", 'console.log(JSON.stringify(require("./lint-staged.config.cjs")["*"]))'],
    { cwd: projectDir, env: { ...cleanEnv(), ...marker }, encoding: "utf8" },
  );
  expect(result).toMatchObject({ stderr: "" });
  return JSON.parse(result.stdout);
}

function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && !agentMarkers.includes(key),
    ),
  );
}

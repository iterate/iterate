import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

// Each row branches `main` and `pull-request` from one base commit, edits the lockfile's lines on
// either side (line number → new text), stamps every commit the way `pnpm install` does, and asks
// git to merge the two. Main edits an early line and the pull request a late one, so the lockfiles
// alone merge cleanly: the shape of a stale lockfile merge.
test.for<{
  name: string;
  main: Record<number, string>;
  pullRequest: Record<number, string>;
  conflicts: string[];
}>([
  {
    name: "main and the pull request both changed the lockfile",
    main: { 2: "  tsdown@0.23.0(typescript@6.0.3): {}" },
    pullRequest: { 17: "  typescript@7.0.2: {}" },
    conflicts: ["pnpm-lock.yaml.sha256"],
  },
  {
    name: "only the pull request changed it",
    main: {},
    pullRequest: { 17: "  typescript@7.0.2: {}" },
    conflicts: [],
  },
  {
    name: "only main changed it",
    main: { 2: "  tsdown@0.23.0(typescript@6.0.3): {}" },
    pullRequest: {},
    conflicts: [],
  },
  {
    name: "both made the same change",
    main: { 17: "  typescript@7.0.2: {}" },
    pullRequest: { 17: "  typescript@7.0.2: {}" },
    conflicts: [],
  },
])("$name", ({ main, pullRequest, conflicts }) => {
  using repository = gitRepository();
  repository.commit("base", {});
  repository.git("checkout", "-q", "-b", "pull-request");
  repository.commit("pull request", pullRequest);
  repository.git("checkout", "-q", "main");
  repository.commit("main", main);
  expect(repository.merge("main", "pull-request")).toEqual(conflicts);
});

function gitRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "lockfile-stamp-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(
    join(cwd, "pnpm-lock.yaml"),
    Array.from({ length: 20 }, (_, line) => `  package-${line}@1.0.0: {}`).join("\n") + "\n",
  );
  return {
    git,
    /** Applies the edits, runs the stamp script as the root `prepare` does, and commits. */
    commit(message: string, edits: Record<number, string>) {
      const lines = readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8").split("\n");
      for (const [line, text] of Object.entries(edits)) lines[Number(line)] = text;
      writeFileSync(join(cwd, "pnpm-lock.yaml"), lines.join("\n"));
      execFileSync(process.execPath, [resolve(import.meta.dirname, "lockfile-stamp.ts")], { cwd });
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
    },
    /** The paths that conflict when `ours` and `theirs` merge, as GitHub's merge would see them. */
    merge(ours: string, theirs: string) {
      const merge = spawnSync(
        "git",
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs],
        { cwd, env, encoding: "utf8" },
      );
      if (merge.status !== 0 && merge.status !== 1) throw new Error(merge.stderr);
      return merge.stdout.trim().split("\n").slice(1);
    },
    [Symbol.dispose]: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

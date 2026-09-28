import { expect, test } from "vitest";
import { MAX_WALK, planInherit, type SuiteCheck } from "./preview-inherit.ts";

// Each case is a pull request's commits before its head, newest first: the suite's latest check on
// each (none, running or with a conclusion) and, for a green one, the files changed from it to the
// head.
type Commit = { sha: string; check?: Partial<SuiteCheck>; changedToHead?: string[] };

test.for<{
  name: string;
  suite: "e2e" | "specs";
  labels?: string[];
  commits: Commit[];
  expected: { inherit: boolean; from?: string };
}>(
  // prettier-ignore
  [
    { name: "a docs-only push", suite: "e2e", commits: [green("c1", ["docs/depot-ci.md", "tasks/x.md"])], expected: { inherit: true, from: "c1" } },
    { name: "a unit-test push", suite: "specs", commits: [green("c1", ["apps/os/src/worker.test.ts"])], expected: { inherit: true, from: "c1" } },
    { name: "a specs-only push, E2E tests", suite: "e2e", commits: [green("c1", ["specs/notes/notes.spec.ts"])], expected: { inherit: true, from: "c1" } },
    { name: "a specs-only push, Browser specs", suite: "specs", commits: [green("c1", ["specs/notes/notes.spec.ts"])], expected: { inherit: false } },
    { name: "a notes push, E2E tests: it tests apps/os alone", suite: "e2e", commits: [green("c1", ["apps/notes/src/app.tsx"])], expected: { inherit: true, from: "c1" } },
    { name: "an os push", suite: "e2e", commits: [green("c1", ["apps/os/src/worker.ts"])], expected: { inherit: false } },
    { name: "a push after a red run", suite: "e2e", commits: [red("c1")], expected: { inherit: false } },
    { name: "a push after a cancelled run, a green one before it", suite: "e2e", commits: [{ sha: "c2", check: { conclusion: "cancelled" } }, green("c1", ["docs/x.md"])], expected: { inherit: true, from: "c1" } },
    { name: "a push after one that pushed two commits", suite: "e2e", commits: [green("c2", ["docs/x.md"]), { sha: "c1" }, green("c0", ["docs/x.md"])], expected: { inherit: true, from: "c2" } },
    { name: "a run still going on the commit before", suite: "e2e", commits: [{ sha: "c2", check: { status: "in_progress", conclusion: null } }, green("c1", ["docs/x.md"])], expected: { inherit: true, from: "c1" } },
    { name: "a dispatch of the other suite skipped this one", suite: "specs", commits: [{ sha: "c2", check: { conclusion: "skipped" } }, red("c1")], expected: { inherit: false } },
    { name: "the first push", suite: "e2e", commits: [], expected: { inherit: false } },
    { name: "GitHub cannot list every changed file", suite: "e2e", commits: [green("c1", undefined)], expected: { inherit: false } },
    { name: "the slow-e2e label, E2E tests", suite: "e2e", labels: ["slow-e2e"], commits: [green("c1", ["docs/x.md"])], expected: { inherit: false } },
    { name: "the slow-e2e label, Browser specs", suite: "specs", labels: ["slow-e2e"], commits: [green("c1", ["docs/x.md"])], expected: { inherit: true, from: "c1" } },
    { name: `a green ${MAX_WALK + 1} commits back`, suite: "e2e", commits: [...Array.from({ length: MAX_WALK }, (_, index) => ({ sha: `n${index}` })), green("c1", ["docs/x.md"])], expected: { inherit: false } },
  ],
)("$name ⇒ inherits: $expected.inherit", async ({ suite, labels = [], commits, expected }) => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const decision = await planInherit({
    suite,
    labels,
    commits: commits.map((commit) => commit.sha),
    checkOn: async (sha) => {
      const check = bySha.get(sha)?.check;
      return (
        check && {
          status: "completed",
          conclusion: "success",
          url: `https://github.com/run/${sha}`,
          ...check,
        }
      );
    },
    changedSince: async (sha) => bySha.get(sha)?.changedToHead,
  });
  expect(decision).toMatchObject(
    expected.from
      ? {
          inherit: true,
          from: { sha: expected.from, url: `https://github.com/run/${expected.from}` },
        }
      : { inherit: false },
  );
});

function green(sha: string, changedToHead: string[] | undefined): Commit {
  return { sha, check: { conclusion: "success" }, changedToHead };
}

function red(sha: string): Commit {
  return { sha, check: { conclusion: "failure" } };
}

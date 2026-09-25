import { expect, test } from "vitest";
import { previewTestedCommit } from "./preview-tested-commit.ts";

const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const main = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const merge = "cccccccccccccccccccccccccccccccccccccccc";
const olderHead = "dddddddddddddddddddddddddddddddddddddddd";

test.for([
  {
    rule: "1: the merge commit built from this head",
    mergeCommit: { sha: merge, parents: [main, head] },
    finalAttempt: false,
    tested: { sha: merge, kind: "merge", mainSha: main },
  },
  {
    rule: "2: a merge commit from an older head is asked for again",
    mergeCommit: { sha: merge, parents: [main, olderHead] },
    finalAttempt: false,
    tested: undefined,
  },
  {
    rule: "2: at the last try, the head alone",
    mergeCommit: { sha: merge, parents: [main, olderHead] },
    finalAttempt: true,
    tested: { sha: head, kind: "head" },
  },
  {
    rule: "3: no merge commit (a conflict): the head alone, at once",
    mergeCommit: undefined,
    finalAttempt: false,
    tested: { sha: head, kind: "head" },
  },
  {
    rule: "a commit with one parent is not a merge commit",
    mergeCommit: { sha: merge, parents: [head] },
    finalAttempt: true,
    tested: { sha: head, kind: "head" },
  },
])("the preview tests, by rule $rule", ({ mergeCommit, finalAttempt, tested }) => {
  const result = previewTestedCommit({ headSha: head, mergeCommit, finalAttempt });
  if (!tested) return expect(result).toBeUndefined();
  expect(result).toMatchObject({ ...tested, headSha: head });
});

test.for([
  {
    mergeCommit: { sha: merge, parents: [main, head] },
    description:
      "the merge commit `ccccccccc`: this PR's head `bbbbbbbbb` merged into main at `aaaaaaaaa`",
  },
  {
    mergeCommit: undefined,
    description:
      "this PR's head `bbbbbbbbb` alone: GitHub has no merge commit, so the PR conflicts with main",
  },
  {
    mergeCommit: { sha: merge, parents: [main, olderHead] },
    description:
      "this PR's head `bbbbbbbbb` alone: GitHub's merge commit was still built from an older head",
  },
])("the PR body says which: $description", ({ mergeCommit, description }) => {
  expect(previewTestedCommit({ headSha: head, mergeCommit, finalAttempt: true })?.description).toBe(
    description,
  );
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { mergesWithMain } from "./merges-with-main.ts";

const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const newerHead = "dddddddddddddddddddddddddddddddddddddddd";
const merge = "cccccccccccccccccccccccccccccccccccccccc";

test.for([
  {
    rule: "1: an answer about a newer head leaves the decision to that push's run",
    pullRequest: pullRequest({ headSha: newerHead, mergeable: false }),
    finalAttempt: false,
    outcome: "superseded",
  },
  {
    rule: "2: a conflict fails the check",
    pullRequest: pullRequest({ mergeable: false }),
    finalAttempt: false,
    outcome: "conflicts",
  },
  {
    rule: "3: a clean merge passes it",
    pullRequest: pullRequest({ mergeable: true }),
    finalAttempt: false,
    outcome: "merges",
  },
  {
    rule: "4: not computed yet is asked for again",
    pullRequest: pullRequest({ mergeable: null }),
    finalAttempt: false,
    outcome: undefined,
  },
  {
    rule: "4: not computed by the last try cannot tell",
    pullRequest: pullRequest({ mergeable: null }),
    finalAttempt: true,
    outcome: "unknown",
  },
])("the check decides by rule $rule", ({ pullRequest, finalAttempt, outcome }) => {
  expect(mergesWithMain({ eventHeadSha: head, pullRequest, finalAttempt })?.outcome).toBe(outcome);
});

test("a conflict says why CI is missing and what to do", () => {
  expect(
    mergesWithMain({
      eventHeadSha: head,
      pullRequest: pullRequest({ mergeable: false }),
      finalAttempt: false,
    })?.message,
  ).toBe(
    "This PR conflicts with main, so GitHub builds no merge commit for it and Depot runs no CI: no Lint and Typecheck, Test or Preview OS. Rebase onto main (or merge main in) and push to get CI.",
  );
});

// `pull_request_target` runs with the base branch's token and files, so the workflow must never
// run the pull request's code or hold a token that can write.
test("merges-with-main.yml runs only the base branch's script, with a read-only token", () => {
  const workflow = parseYaml(
    readFileSync(
      resolve(import.meta.dirname, "../../.github/workflows/merges-with-main.yml"),
      "utf8",
    ),
  ) as {
    on: Record<string, { types?: string[] }>;
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Array<{ uses?: string; run?: string; with?: object }> }>;
  };
  expect(workflow).toMatchObject({
    on: { pull_request_target: { types: ["opened", "synchronize", "reopened"] } },
    permissions: { contents: "read", "pull-requests": "read" },
  });
  expect(Object.keys(workflow.on)).toEqual(["pull_request_target"]);
  expect(Object.keys(workflow.permissions).sort()).toEqual(["contents", "pull-requests"]);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"));
  expect(checkout?.with).not.toHaveProperty("ref");
  expect(checkout?.with).toMatchObject({
    "persist-credentials": false,
    "sparse-checkout": "scripts/ci/merges-with-main.ts",
  });
  expect(steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
    "node scripts/ci/merges-with-main.ts",
  ]);
});

function pullRequest(overrides: { headSha?: string; mergeable: boolean | null }) {
  return {
    head: { sha: overrides.headSha || head },
    base: { ref: "main" },
    mergeable: overrides.mergeable,
    merge_commit_sha: overrides.mergeable ? merge : null,
  };
}

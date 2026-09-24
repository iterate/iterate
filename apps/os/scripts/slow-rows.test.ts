import { SLOW_ROW_PATHS } from "@iterate-com/shared/test-support/e2e-policy";
import { expect, test } from "vitest";
import { chooseSlowRows, SLOW_ROWS_LABEL, slowRowsTagsFilter } from "./slow-rows.ts";

test.each([
  {
    case: "a PR that changes the code the slow rows prove, but neither turns them on nor edits one, skips them",
    pullRequest: pullRequest(
      ["infra"],
      ["apps/os/src/context/facet-host.ts", "apps/os/src/iterate-context-durable-object.ts"],
    ),
    slowRows: "skip",
    reason: "PR #7 carries no slow-e2e label and changes no slow row's file",
  },
  {
    case: "a PR that changes the rows themselves runs them",
    pullRequest: pullRequest([], ["apps/os/e2e/context-residency.e2e.test.ts"]),
    slowRows: "run",
    reason: "PR #7 changes apps/os/e2e/context-residency.e2e.test.ts",
  },
  {
    case: "a PR with the label runs them, whatever it changes",
    pullRequest: pullRequest([SLOW_ROWS_LABEL], ["docs/testing.md"]),
    slowRows: "run",
    reason: "PR #7 carries the slow-e2e label",
  },
  {
    case: "a PR whose label and paths GitHub did not answer runs them",
    pullRequest: async () => {
      throw new Error("GitHub GET /repos/iterate/iterate/pulls/7 failed with 502");
    },
    slowRows: "run",
    reason:
      "PR #7's label and paths are unknown (GitHub GET /repos/iterate/iterate/pulls/7 failed with 502)",
  },
])("$case", async ({ pullRequest: readPullRequest, slowRows, reason }) => {
  expect(await chooseSlowRows({ requested: undefined, prNumber: "7", readPullRequest })).toEqual({
    slowRows,
    reason,
  });
});

test("every file SLOW_ROW_PATHS names runs the slow rows on its own", async () => {
  for (const path of SLOW_ROW_PATHS)
    expect(
      await chooseSlowRows({
        requested: undefined,
        prNumber: "7",
        readPullRequest: pullRequest([], [path]),
      }),
    ).toMatchObject({ slowRows: "run" });
});

test("without a pull request (main, the scheduled run, a laptop) every row runs, and nothing is read", async () => {
  expect(
    await chooseSlowRows({ requested: undefined, prNumber: undefined, readPullRequest: unread }),
  ).toEqual({ slowRows: "run", reason: "no pull request" });
});

test.each(["run", "skip", "only"] as const)(
  "what was asked for (E2E_SLOW_ROWS, --slow-rows) wins, and nothing is read: %s",
  async (requested) => {
    expect(await chooseSlowRows({ requested, prNumber: "7", readPullRequest: unread })).toEqual({
      slowRows: requested,
      reason: "asked for",
    });
  },
);

test("the vitest arguments pick the rows by their tag", () => {
  expect(slowRowsTagsFilter("run")).toEqual([]);
  expect(slowRowsTagsFilter("skip")).toEqual(["--tags-filter", "!slow"]);
  expect(slowRowsTagsFilter("only")).toEqual(["--tags-filter", "slow"]);
});

function pullRequest(labels: string[], paths: string[]) {
  return async () => ({ labels, paths });
}

async function unread(): Promise<never> {
  throw new Error("the pull request was not read");
}

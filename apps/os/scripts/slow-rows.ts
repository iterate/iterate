// scripts/slow-rows.ts — WHICH E2E ROWS A RUN AGAINST A PREVIEW INCLUDES (docs/testing.md#slow-rows).
// A row tagged `slow` waits out real platform time (a quiet minute, a sweep, an alarm), so a PR that
// changes none of its code skips it and finishes as soon as its slowest other row does. The rows
// still run on a PR that changes a file of `SLOW_ROW_PATHS` or carries the `slow-e2e` label, on every
// main push (Main OS e2e) and every 2 hours against main (os-slow-e2e.yml). The pure half;
// scripts/preview.ts `runSuite` reads the pull request and runs the suite.
import { SLOW_ROW_PATHS } from "@iterate-com/shared/test-support/e2e-policy";
import { z } from "zod";

/** run: every row. skip: every row but those tagged `slow`. only: those alone. `--slow-rows` and
 *  E2E_SLOW_ROWS ask for one; unset, `chooseSlowRows` decides. */
export const SlowRows = z.enum(["run", "skip", "only"]);
export type SlowRows = z.infer<typeof SlowRows>;

/** The pull-request label that runs the slow rows on a PR whose paths alone would skip them. */
export const SLOW_ROWS_LABEL = "slow-e2e";

/** What was asked for, else every row without a pull request (main, the scheduled run, a laptop),
 *  else by the PR's label and changed paths. A PR whose label or paths cannot be read runs every
 *  row: a missed slow row would reach main unproven. */
export async function chooseSlowRows(input: {
  requested: SlowRows | undefined;
  prNumber: string | undefined;
  readPullRequest: () => Promise<{ labels: string[]; paths: string[] }>;
}): Promise<{ slowRows: SlowRows; reason: string }> {
  if (input.requested) return { slowRows: input.requested, reason: "asked for" };
  if (!input.prNumber) return { slowRows: "run", reason: "no pull request" };
  const pr = `PR #${input.prNumber}`;
  let pullRequest: { labels: string[]; paths: string[] };
  try {
    pullRequest = await input.readPullRequest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { slowRows: "run", reason: `${pr}'s label and paths are unknown (${message})` };
  }
  if (pullRequest.labels.includes(SLOW_ROWS_LABEL))
    return { slowRows: "run", reason: `${pr} carries the ${SLOW_ROWS_LABEL} label` };
  const touched = pullRequest.paths.filter((path) => SLOW_ROW_PATHS.includes(path));
  if (touched.length > 0) return { slowRows: "run", reason: `${pr} changes ${touched.join(", ")}` };
  return {
    slowRows: "skip",
    reason: `${pr} changes none of SLOW_ROW_PATHS and carries no ${SLOW_ROWS_LABEL} label`,
  };
}

/** The `vitest` arguments that pick the rows. */
export function slowRowsTagsFilter(slowRows: SlowRows): string[] {
  if (slowRows === "run") return [];
  return ["--tags-filter", slowRows === "skip" ? "!slow" : "slow"];
}

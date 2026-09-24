import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { E2E_SLEEP_CEILING_MS, SLOW_ROW_PATHS } from "@iterate-com/shared/test-support/e2e-policy";
import { expect, test } from "vitest";

// THE E2E ROW BUDGET, from source (docs/testing.md#the-row-budget). A row's timeout is held to its
// ceiling at runtime (apps/os/e2e/support/setup.ts); what that cannot see is a row's fixed waits,
// which files have rows tagged `slow`, and a second retry setting. Deliberately dumb, like
// lint/dated-skips.test.ts: a regex over the e2e files' text, no parser. A wait written with a
// named constant, or computed at runtime, passes unseen.

const repoRoot = resolve(import.meta.dirname, "../..");
const SELF = "scripts/ci/e2e-policy.test.ts";
const files = ["apps/os/e2e", "apps/agents/e2e"]
  .flatMap((directory) => tsFilesBelow(join(repoRoot, directory)))
  .map((path) => ({ file: relative(repoRoot, path), text: readFileSync(path, "utf8") }));

/**
 * The waits over the ceiling a row makes on purpose: a row tagged `slow`, or one gated off PRs.
 * `wait` is the call's text, so an entry survives line drift.
 */
const ALLOWED_WAITS = [
  {
    file: "apps/os/e2e/context-residency.e2e.test.ts",
    wait: "sleep(110_000)",
    note: "slow row: the sweep's alarm is the evicted context's only wake",
  },
  {
    file: "apps/os/e2e/context-residency.e2e.test.ts",
    wait: "sleep(120_000)",
    note: "slow row: the facet's own appends are the context's only callers",
  },
  {
    file: "apps/os/e2e/context-residency.e2e.test.ts",
    wait: "sleep(180_000)",
    note: "slow row: the sweep runs at ~60 s and the release lands at 70 s",
  },
];

test(`no e2e row that runs on every PR waits longer than ${E2E_SLEEP_CEILING_MS / 1000} s`, () => {
  const waits = files.flatMap(({ file, text }) =>
    fixedWaits(text).map((wait) => ({ file, ...wait })),
  );
  expect(waits.length).toBeGreaterThan(20);
  const long = waits.filter((wait) => wait.ms > E2E_SLEEP_CEILING_MS);
  const allowed = (wait: (typeof long)[number]) =>
    ALLOWED_WAITS.find((entry) => entry.file === wait.file && entry.wait === wait.call);
  expect(
    long.filter((wait) => !allowed(wait)).map((wait) => `${wait.file}:${wait.line} ${wait.call}`),
    `Poll for the condition instead (\`until\`, \`expect.poll\`). A row that must wait out real platform time is a "slow" row, and its wait an ALLOWED_WAITS entry in ${SELF} (docs/testing.md#the-row-budget)`,
  ).toEqual([]);
  expect(
    ALLOWED_WAITS.filter((entry) => !long.some((wait) => allowed(wait) === entry)),
    `ALLOWED_WAITS entries in ${SELF} that match no wait any more: remove them`,
  ).toEqual([]);
});

test("E2E_CI_RETRIES is the one retry setting an e2e row has", () => {
  const settings = files.flatMap(({ file, text }) =>
    [...text.matchAll(/\bretr(?:y|ies):\s*([^,\n}]+)/gu)].map((match) => ({
      at: `${file}:${lineOf(text, match.index)}`,
      value: match[1]!.trim(),
    })),
  );
  expect(settings.length).toBeGreaterThan(0);
  expect(
    settings.filter(({ value }) => !["0", "process.env.CI ? E2E_CI_RETRIES : 0"].includes(value)),
  ).toEqual([]);
});

// A PR runs the rows tagged slow when it changes a file of SLOW_ROW_PATHS (apps/os/scripts/slow-rows.ts),
// so a slow row's own file is one: a PR that edits the row runs it.
test("every file with a row tagged slow is in SLOW_ROW_PATHS", () => {
  const slow = files.filter(({ text }) => /\btags:\s*\[[^\]]*["']slow["']/u.test(text));
  expect(slow.length).toBeGreaterThan(0);
  expect(slow.map(({ file }) => file).filter((file) => !SLOW_ROW_PATHS.includes(file))).toEqual([]);
});

test("every SLOW_ROW_PATHS entry is a file in the repository", () => {
  expect(SLOW_ROW_PATHS.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([]);
});

test("the guard reads each way a row writes a fixed wait", () => {
  const source = [
    "await sleep(31_000);",
    "await delay(45000)",
    'setTimeout(() => resolve("late"), 60_000);',
    'setTimeout(\n  () => reject(new Error("late")),\n  60_000,\n);',
    "await new Promise((r) => setTimeout(r, 1000));",
    "setTimeout(tick, ms);",
    "await sleep(SEED_MS);",
  ].join("\n");
  expect(fixedWaits(source).map(({ line, ms }) => [line, ms])).toEqual([
    [1, 31_000],
    [2, 45_000],
    [3, 60_000],
    [8, 1_000],
  ]);
});

/**
 * Every `sleep(ms)`, `delay(ms)` and `setTimeout(fn, ms)` whose `ms` is a numeric literal. A timer
 * that rejects is a deadline raced against the work, not a wait, and is left out.
 */
function fixedWaits(text: string) {
  const pattern =
    /\b(?:sleep|delay)\(\s*([\d_]+)\s*\)|\bsetTimeout\(([^;]*?),\s*([\d_]+)\s*,?\s*\)/gu;
  return [...text.matchAll(pattern)].flatMap((match) =>
    match[2]?.includes("reject")
      ? []
      : [
          {
            call: match[0],
            line: lineOf(text, match.index),
            ms: Number((match[1] ?? match[3])!.replaceAll("_", "")),
          },
        ],
  );
}

function lineOf(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

function tsFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsFilesBelow(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

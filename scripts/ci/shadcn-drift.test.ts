import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { driftOf, parseDryRun, upstreamReport, VENDORED_FILES } from "./shadcn-drift.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

// `shadcn add <items> --dry-run` from shadcn@4.21.0, NO_COLOR, cut to three files.
const dryRunOutput = `- Resolving items.
┌ shadcn add alert-dialog, avatar, command (dry run)
│
├ Files (3) =1 skip, ~1 overwrite, +1 new
│ = src/components/avatar.tsx         skip (identical)
│ ~ src/hooks/use-mobile.ts           overwrite
│ + src/components/input-group.tsx    create
│
├ Dependencies (1)
│ + cn
│
│ 3 files, 1 dep
│
└ Run without --dry-run to apply.
`;

test("reads each file of the dry run's summary by its repository path", () => {
  expect(parseDryRun(dryRunOutput)).toEqual({
    files: [
      { path: "packages/ui/src/components/avatar.tsx", action: "skip" },
      { path: "packages/ui/src/hooks/use-mobile.ts", action: "overwrite" },
      { path: "packages/ui/src/components/input-group.tsx", action: "create" },
    ],
    css: false,
  });
  expect(parseDryRun(`${dryRunOutput}├ CSS\n│ + Updated src/styles/globals.css\n`)).toMatchObject({
    css: true,
  });
});

test("no drift when the CLI would skip every vendored file", () => {
  expect(driftOf(VENDORED_FILES.map((path) => ({ path, action: "skip" })))).toEqual([]);
});

test("drift names an overwritten file, a file off the list, and a file upstream stopped writing", () => {
  const files = VENDORED_FILES.filter((path) => !path.endsWith("/input-group.tsx")).map((path) => ({
    path,
    action: path.endsWith("/button.tsx") ? "overwrite" : "skip",
  }));
  files.push({ path: "packages/ui/src/components/kbd.tsx", action: "create" });
  expect(driftOf(files)).toEqual([
    "packages/ui/src/components/button.tsx (overwrite)",
    "packages/ui/src/components/kbd.tsx (create, not on the vendored list)",
    "packages/ui/src/components/input-group.tsx (upstream no longer writes it)",
  ]);
});

test("reports upstream moving once, again when the set of files changes, and once back in sync", () => {
  const drift = ["packages/ui/src/components/button.tsx (overwrite)"];
  const first = upstreamReport({ drift, messages: [], runUrl: "https://depot.dev/run" });
  expect(first).toBe(
    [
      "🧩 shadcn upstream moved: 1 vendored file in packages/ui differs from `shadcn add`",
      "• packages/ui/src/components/button.tsx (overwrite)",
      "Refresh with `pnpm tsx scripts/ci/shadcn-drift.ts refresh` and review the diff (packages/ui/AGENTS.md).",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  );

  const history = [
    { text: "someone chatting", bot_id: undefined },
    { text: first!, bot_id: "B1" },
  ];
  expect(upstreamReport({ drift, messages: history })).toBeNull();
  expect(
    upstreamReport({
      drift: [...drift, "packages/ui/src/components/tabs.tsx (overwrite)"],
      messages: history,
    }),
  ).toMatch(/^🧩 shadcn upstream moved: 2 vendored files/);
  expect(upstreamReport({ drift: [], messages: history })).toBe(
    "🧩 shadcn upstream: packages/ui's vendored files match upstream again",
  );
});

test("in sync with no earlier report posts nothing", () => {
  expect(upstreamReport({ drift: [], messages: [] })).toBeNull();
  expect(
    upstreamReport({
      drift: [],
      messages: [
        {
          text: "🧩 shadcn upstream: packages/ui's vendored files match upstream again",
          bot_id: "B1",
        },
      ],
    }),
  ).toBeNull();
});

// The vendored files are excluded from our own tooling, and a pull request that touches one runs
// the drift check: every list names the same files.
test.for([
  { list: ".oxlintrc.json ignorePatterns", read: () => json(".oxlintrc.json").ignorePatterns },
  { list: ".oxfmtrc.json ignorePatterns", read: () => json(".oxfmtrc.json").ignorePatterns },
  {
    list: "shadcn-drift.yml pull_request paths",
    read: () =>
      (
        parseYaml(read(".depot/workflows/shadcn-drift.yml")) as {
          on: { pull_request: { paths: string[] } };
        }
      ).on.pull_request.paths,
  },
])("$list names every vendored file", ({ read }) => {
  expect(read()).toEqual(expect.arrayContaining(VENDORED_FILES));
});

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function json(path: string) {
  return JSON.parse(read(path)) as { ignorePatterns: string[] };
}

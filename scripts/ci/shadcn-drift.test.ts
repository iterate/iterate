import { readdirSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { driftOf, parseView, upstreamReport, VENDORED_FILES } from "./shadcn-drift.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

// `shadcn add <items> --dry-run --view src/` from shadcn@4.21.0, NO_COLOR, cut to two files: the
// box's `│ │ ` before an empty line keeps its trailing space.
const viewOutput = `- Resolving items.
┌ shadcn add skeleton, use-mobile (dry run)
│
├ src/components/skeleton.tsx (overwrite) 4 lines
│ ┌──────────────────────────────────────────────
│ │ import { cn } from "cn"
│ │ 
│ │   export { Skeleton }
│ │ 
│ └──────────────────────────────────────────────
│
├ src/hooks/use-mobile.ts (skip) 2 lines
│ ┌──────────────────────────────────────────────
│ │ export const MOBILE_BREAKPOINT = 768
│ │ 
│ └──────────────────────────────────────────────
│
└ Run without --dry-run to apply.
`;

test("reads each file of the dry run's view by its repository path, with its exact content", () => {
  expect(parseView(viewOutput)).toEqual([
    {
      path: "packages/ui/src/components/skeleton.tsx",
      action: "overwrite",
      content: 'import { cn } from "cn"\n\n  export { Skeleton }\n',
    },
    {
      path: "packages/ui/src/hooks/use-mobile.ts",
      action: "skip",
      content: "export const MOBILE_BREAKPOINT = 768\n",
    },
  ]);
  expect(() => parseView(viewOutput.replace("(skip) 2 lines", "(skip) 3 lines"))).toThrow(
    /printed 2 of src\/hooks\/use-mobile.ts's 3 lines/,
  );
});

test("no drift when every vendored file holds upstream's bytes and globals.css needs nothing", () => {
  const { files, current } = inSync();
  expect(driftOf(files, current)).toEqual([]);
  const css = {
    path: "packages/ui/src/styles/globals.css",
    action: "skip",
    content: "@theme {}\n",
  };
  expect(driftOf([...files, css], current)).toEqual([]);
});

test("drift names an overwritten file, whitespace the CLI ignores, a file off the list, a file upstream stopped writing, and CSS", () => {
  const { files, repository, current } = inSync();
  const button = files.find((file) => file.path.endsWith("/button.tsx"))!;
  Object.assign(button, { action: "overwrite", content: "upstream's button\n" });
  repository.set(
    "packages/ui/src/components/skeleton.tsx",
    "packages/ui/src/components/skeleton.tsx\n\n",
  );
  const withoutInputGroup = files.filter((file) => !file.path.endsWith("/input-group.tsx"));
  withoutInputGroup.push(
    { path: "packages/ui/src/components/kbd.tsx", action: "create", content: "kbd\n" },
    { path: "packages/ui/src/styles/globals.css", action: "update", content: "@theme {}\n" },
  );
  expect(driftOf(withoutInputGroup, current)).toEqual([
    "packages/ui/src/components/button.tsx (overwrite)",
    "packages/ui/src/components/skeleton.tsx (whitespace)",
    "packages/ui/src/components/kbd.tsx (create, not on the vendored list)",
    "packages/ui/src/styles/globals.css (update)",
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

// A rule in rules/ applies where a `files` glob matches and no `!` glob excludes (AGENTS.md).
test("every rules/ rule whose globs match a vendored file excludes it", () => {
  const rules = readdirSync(resolve(repoRoot, "rules"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => {
      const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(read(`rules/${path}`))?.[1] || "";
      // YAML front matter: `files` is the rule's list of globs, `!` ones excluding
      return { path, files: (parseYaml(frontMatter) as { files?: string[] } | null)?.files };
    })
    .filter((rule) => rule.files);
  expect(rules.length).toBeGreaterThan(0);
  const applied = rules.flatMap(({ path, files }) =>
    VENDORED_FILES.filter(
      (file) =>
        files!.some((glob) => !glob.startsWith("!") && matchesGlob(file, glob)) &&
        !files!.some((glob) => glob.startsWith("!") && matchesGlob(file, glob.slice(1))),
    ).map((file) => `rules/${path}: ${file}`),
  );
  expect(applied).toEqual([]);
});

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function json(path: string) {
  return JSON.parse(read(path)) as { ignorePatterns: string[] };
}

/** Upstream's content for every vendored file, and the repository holding exactly that. */
function inSync() {
  const files = VENDORED_FILES.map((path) => ({ path, action: "skip", content: `${path}\n` }));
  const repository = new Map(files.map((file) => [file.path, file.content]));
  return { files, repository, current: (path: string) => repository.get(path) };
}

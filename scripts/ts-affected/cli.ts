// scripts/ts-affected/cli.ts — EXPERIMENT (tasks/typescript-change-detection.md): what does
// changing a file reach, per TypeScript? engine.ts has the machinery.
//
//   node scripts/ts-affected/cli.ts programs
//   node scripts/ts-affected/cli.ts file packages/shared/src/slugify.ts
//   node scripts/ts-affected/cli.ts symbol packages/shared/src/slugify.ts slugify
//   node scripts/ts-affected/cli.ts experiment        # the task file's file-level table
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";

import {
  fileClosure,
  graphClosure,
  graphImporters,
  loadRepo,
  type FileNerf,
  type Repo,
} from "./engine.ts";
import { touchesPreview } from "../ci/preview-paths.ts";
import { itemKey, seedForExport, seedsFromDiff, symbolClosure } from "./symbols.ts";

/** The tsc programs `pnpm typecheck` runs, how many repo files each reads, and the baseline errors. */
export async function programs() {
  const repo = await loadRepo(process.cwd());
  for (const program of repo.programs) {
    const files = [...repo.programsByFile].filter(([, programs]) => programs.includes(program));
    console.log(`${program.padEnd(45)} ${String(files.length).padStart(5)} files`);
  }
  console.log(
    `\n${repo.programsByFile.size} files in at least one program; ${repo.baseline.size} baseline errors; ${Math.round(repo.msToLoad)}ms`,
  );
}

/**
 * Nerfs one file level by level, both ways (`empty` replaces it with `export {};`, `delete` removes
 * it), and prints who breaks beside who imports it per `tsc --explainFiles`.
 */
export async function file(file: string) {
  const repo = await loadRepo(process.cwd());
  console.log(JSON.stringify(await measure(repo, file), null, 2));
}

/**
 * Nerfs one export by renaming it, then everything that breaks, round by round, and prints the
 * declarations, imports and tests it reached.
 */
export async function symbol(file: string, name: string) {
  const repo = await loadRepo(process.cwd());
  const { affected, via, rounds } = await symbolClosure(repo, [seedForExport(repo, file, name)]);
  for (const item of affected)
    console.log(`${itemKey(item)}  ← ${via.get(itemKey(item)) || "(seed)"}`);
  console.log(
    `\n${affected.length} items in ${new Set(affected.map((i) => i.file)).size} files; rounds: ${JSON.stringify(rounds)}`,
  );
}

/**
 * What a commit reaches, two ways: the import-graph closure of every changed file, and the symbol
 * closure of the top-level statements its changed lines touch. Beside them, what
 * scripts/ci/preview-paths.ts's globs decide. Prints one JSON line.
 */
export async function diff(options: {
  /** The commit to compare against, e.g. `HEAD^`. */
  base: string;
  /** The checkout to measure (a lab checkout of an older commit); default the current directory. */
  root?: string;
}) {
  const repo = await loadRepo(path.resolve(options.root || process.cwd()));
  const { seeds, invisible, files } = seedsFromDiff(repo, options.base);
  const tsFiles = files.filter((f) => repo.programsByFile.has(f));
  const fileLevel = [...new Set(tsFiles.flatMap((f) => graphClosure(repo, f).flat()))];
  const { affected, rounds } = await symbolClosure(repo, seeds);
  const symbolFiles = [...new Set(affected.map((item) => item.file))];
  const tests = affected.filter((item) => item.kind === "statement" && isTest(item.file));
  const title = execFileSync("git", ["log", "-1", "--format=%h %s", "HEAD"], {
    cwd: repo.root,
    encoding: "utf8",
  }).trim();
  console.log(
    JSON.stringify({
      title,
      changed: files.length,
      invisible,
      preview: touchesPreview(files),
      fileLevel: {
        files: fileLevel.length,
        testFiles: fileLevel.filter(isTest).length,
        workspaces: workspaces(fileLevel.filter((f) => !isTest(f))),
      },
      symbolLevel: {
        seeds: seeds.length,
        files: symbolFiles.length,
        testFiles: symbolFiles.filter(isTest).length,
        tests: tests.length,
        workspaces: workspaces(symbolFiles.filter((f) => !isTest(f))),
        rounds: rounds.length,
        ms: Math.round(rounds.reduce((sum, round) => sum + round.ms, 0)),
      },
      msToLoad: Math.round(repo.msToLoad),
    }),
  );
}

/** Measures every sample file with both strategies; writes results.ignoreme.json and prints the table. */
export async function experiment() {
  const repo = await loadRepo(process.cwd());
  const rows = [];
  for (const sample of samples) {
    console.error(`measuring ${sample.file}`);
    rows.push({
      ...sample,
      ...(await measure(repo, sample.file)),
      symbolResult: await measureSymbol(repo, sample.file, sample.symbol),
    });
    writeFileSync(
      path.join(import.meta.dirname, "results.ignoreme.json"),
      JSON.stringify(rows, null, 2),
    );
  }
  console.log(renderTable(rows));
}

/** Renders results.ignoreme.json as the task file's table, without re-measuring. */
export async function table() {
  const { readFileSync } = await import("node:fs");
  console.log(
    renderTable(
      JSON.parse(readFileSync(path.join(import.meta.dirname, "results.ignoreme.json"), "utf8")),
    ),
  );
}

const samples = [
  { kind: "leaf util", file: "packages/shared/src/slugify.ts", symbol: "slugify" },
  {
    kind: "shared runtime util",
    file: "packages/shared/src/platform-retry.ts",
    symbol: "CLOUDFLARE_API",
  },
  { kind: "cross-app config", file: "packages/shared/src/app-config.ts", symbol: "dnsName" },
  { kind: "SDK core", file: "packages/iterate/src/lib.ts", symbol: "cookieValueOf" },
  { kind: "app-internal hub", file: "apps/os/src/caller.ts", symbol: "bytesFromBase64url" },
  { kind: "oRPC contract", file: "apps/os/src/secret/contract.ts", symbol: "LendRevokedReason" },
  {
    kind: "shared React component",
    file: "packages/ui/src/components/button.tsx",
    symbol: "buttonVariants",
  },
  {
    kind: "app React component",
    file: "apps/dash/src/components/identifier.tsx",
    symbol: "Identifier",
  },
  { kind: "e2e test helper", file: "apps/os/e2e/support/client.ts", symbol: "mcpCall" },
  {
    kind: "browser-spec helper",
    file: "specs/test-support/auth-config.ts",
    symbol: "readOsPlaywrightAuthConfig",
  },
  { kind: "deploy/CI lib", file: "scripts/lib/env-context.ts", symbol: "cloudflareApi" },
  { kind: "ambient globals (.d.ts)", file: "apps/os/src/dom.d.ts", symbol: "" },
  { kind: "ambient module (.d.ts)", file: "packages/voice/src/markdown.d.ts", symbol: "" },
];

async function measure(repo: Repo, file: string) {
  const graph = graphClosure(repo, file);
  return {
    programs: repo.programsByFile.get(file) || [],
    graph: {
      direct: graphImporters(repo, file),
      closure: graph.slice(1).flat(),
      levelSizes: graph.slice(1).map((level) => level.length),
    },
    empty: await measureNerf(repo, file, "empty"),
    delete: await measureNerf(repo, file, "delete"),
  };
}

async function measureNerf(repo: Repo, file: string, strategy: FileNerf) {
  const { levels, rounds } = await fileClosure(repo, file, strategy);
  return {
    direct: levels[1] || [],
    closure: levels.slice(1).flat(),
    levelSizes: levels.slice(1).map((level) => level.length),
    directMs: Math.round(rounds[0].ms),
    closureMs: Math.round(rounds.reduce((sum, round) => sum + round.ms, 0)),
    directCodes: countBy(rounds[0].codes),
  };
}

/** One export's reach, when the sample names one (an ambient `.d.ts` has none to rename). */
async function measureSymbol(repo: Repo, file: string, name: string) {
  if (!name) return null;
  const { affected, via, rounds } = await symbolClosure(repo, [seedForExport(repo, file, name)]);
  const files = [...new Set(affected.map((item) => item.file))].filter((f) => f !== file);
  return {
    items: affected.map((item) => ({ key: itemKey(item), via: via.get(itemKey(item)) || null })),
    files,
    tests: affected.filter((item) => item.kind === "statement" && isTest(item.file)).map(itemKey),
    ms: Math.round(rounds.reduce((sum, round) => sum + round.ms, 0)),
    rounds: rounds.length,
  };
}

type Row = Awaited<ReturnType<typeof measure>> &
  (typeof samples)[number] & { symbolResult: Awaited<ReturnType<typeof measureSymbol>> };

function renderTable(rows: Row[]) {
  const header = [
    "sample",
    "kind",
    "direct: graph / empty / delete",
    "closure: graph / empty / delete",
    "closure only by nerf (delete)",
    "closure only by graph (delete)",
    "workspaces reached",
    "test files reached",
    "time direct / closure (delete)",
  ];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const onlyNerf = row.delete.closure.filter((f) => !row.graph.closure.includes(f));
    const onlyGraph = row.graph.closure.filter((f) => !row.delete.closure.includes(f));
    const union = [...new Set([...row.delete.closure, ...row.empty.closure])];
    lines.push(
      `| \`${row.file}\` | ${row.kind} | ${row.graph.direct.length} / ${row.empty.direct.length} / ${row.delete.direct.length} | ${row.graph.closure.length} / ${row.empty.closure.length} / ${row.delete.closure.length} | ${onlyNerf.length} | ${onlyGraph.length} | ${workspaces(union).join(", ") || "none"} | ${union.filter(isTest).length} | ${(row.delete.directMs / 1000).toFixed(1)}s / ${(row.delete.closureMs / 1000).toFixed(0)}s (${row.delete.levelSizes.length} rounds) |`,
    );
  }
  return lines.join("\n");
}

function workspaces(files: string[]) {
  return [
    ...new Set(
      files.map((f) =>
        /^(apps|packages)\//.test(f) ? f.split("/").slice(0, 2).join("/") : f.split("/")[0],
      ),
    ),
  ].sort();
}

function isTest(file: string) {
  return /\.(test|spec|e2e\.test|perf\.test)\.tsx?$/.test(file) || file.startsWith("specs/");
}

function countBy(values: string[]) {
  return Object.fromEntries(
    [...new Set(values)].map((v) => [v, values.filter((x) => x === v).length]),
  );
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "ts-affected" }).run();

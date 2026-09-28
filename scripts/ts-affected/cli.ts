// scripts/ts-affected/cli.ts — EXPERIMENT (tasks/complete/2026-09-28-typescript-change-detection.md): what does
// changing a file reach, per TypeScript? engine.ts has the machinery.
//
//   node scripts/ts-affected/cli.ts programs
//   node scripts/ts-affected/cli.ts file packages/shared/src/slugify.ts
//   node scripts/ts-affected/cli.ts symbol packages/shared/src/slugify.ts slugify --granularity member
//   node scripts/ts-affected/cli.ts diff --base HEAD^ --granularity member
//   node scripts/ts-affected/cli.ts replay c3f4601d7 4d2e7a976 --lab ../lab --granularity member
//   node scripts/ts-affected/cli.ts experiment && node scripts/ts-affected/cli.ts table
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";

import { touchesPreview } from "../ci/preview-paths.ts";
import {
  fileClosure,
  graphClosure,
  graphImporters,
  loadRepo,
  type FileNerf,
  type Repo,
} from "./engine.ts";
import {
  itemKey,
  seedForExport,
  seedsFromDiff,
  symbolClosure,
  type Granularity,
} from "./symbols.ts";

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
 * declarations, members, imports and tests it reached, each with the item whose error found it.
 */
export async function symbol(file: string, name: string, options: { granularity: Granularity }) {
  const repo = await loadRepo(process.cwd());
  const seeds = [seedForExport(repo, file, name)];
  const { affected, via, rounds } = await symbolClosure(repo, seeds, options.granularity);
  for (const item of affected)
    console.log(`${itemKey(item)}  ← ${via.get(itemKey(item)) || "(seed)"}`);
  console.log(
    `\n${affected.length} items in ${new Set(affected.map((i) => i.file)).size} files; rounds: ${JSON.stringify(rounds)}`,
  );
}

/**
 * What a commit reaches, two ways: the import-graph closure of every changed file, and the symbol
 * closure of the statements (or members) its changed lines touch. Beside them, what
 * scripts/ci/preview-paths.ts's globs decide. Prints one JSON line.
 */
export async function diff(options: {
  /** The commit to compare against, e.g. `HEAD^`. */
  base: string;
  /** The checkout to measure (a lab checkout of an older commit); default the current directory. */
  root?: string;
  granularity: Granularity;
}) {
  const repo = await loadRepo(path.resolve(options.root || process.cwd()));
  const { seeds, invisible, files } = seedsFromDiff(repo, options.base, options.granularity);
  const tsFiles = files.filter((f) => repo.programsByFile.has(f));
  const fileLevel = [...new Set(tsFiles.flatMap((f) => graphClosure(repo, f).flat()))];
  const { affected, rounds } = await symbolClosure(repo, seeds, options.granularity);
  const symbolFiles = [...new Set(affected.map((item) => item.file))];
  const tests = affected.filter((item) => item.kind === "statement" && isTest(item.file));
  const title = execFileSync("git", ["log", "-1", "--format=%h %s", "HEAD"], {
    cwd: repo.root,
    encoding: "utf8",
  }).trim();
  console.log(
    JSON.stringify({
      title,
      granularity: options.granularity,
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

/**
 * Replays merged commits: checks each out in `lab` (a spare worktree whose files this may change),
 * installs, and prints `diff`'s JSON line for it. The task file's commit table came from this.
 */
export async function replay(
  commits: string[],
  options: { lab: string; granularity: Granularity },
) {
  for (const commit of commits) {
    execFileSync("git", ["checkout", "-q", "--detach", commit], { cwd: options.lab });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: options.lab,
      stdio: "ignore",
    });
    await diff({ base: `${commit}^`, root: options.lab, granularity: options.granularity });
  }
}

/**
 * Nerfs every sample file, level by level, both ways; writes results-files.ignoreme.json beside
 * this file.
 */
export async function experiment() {
  const repo = await loadRepo(process.cwd());
  const rows = [];
  for (const sample of samples) {
    console.error(`measuring ${sample.file}`);
    rows.push({ ...sample, ...(await measure(repo, sample.file)) });
    writeFileSync(resultsPath("files"), JSON.stringify(rows, null, 2));
  }
}

/** Nerfs every sample's one export; writes results-symbols-<granularity>.ignoreme.json. */
export async function symbolSamples(options: { granularity: Granularity }) {
  const repo = await loadRepo(process.cwd());
  const rows = [];
  for (const sample of samples.filter((s) => s.symbol)) {
    console.error(`measuring ${sample.file} ${sample.symbol}`);
    rows.push({
      file: sample.file,
      ...(await measureSymbol(repo, sample.file, sample.symbol, options.granularity)),
    });
    writeFileSync(resultsPath(`symbols-${options.granularity}`), JSON.stringify(rows, null, 2));
  }
}

/** Renders the results files as the task file's two tables, without re-measuring. */
export async function table() {
  const files: FileRow[] = JSON.parse(readFileSync(resultsPath("files"), "utf8"));
  const bySymbol = (granularity: Granularity): SymbolRow[] =>
    JSON.parse(readFileSync(resultsPath(`symbols-${granularity}`), "utf8"));
  console.log(renderFileTable(files));
  console.log();
  console.log(renderSymbolTable(files, bySymbol("declaration"), bySymbol("member")));
}

function resultsPath(name: string) {
  return path.join(import.meta.dirname, `results-${name}.ignoreme.json`);
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

/** One export's reach. */
async function measureSymbol(repo: Repo, file: string, name: string, granularity: Granularity) {
  const { affected, via, rounds } = await symbolClosure(
    repo,
    [seedForExport(repo, file, name)],
    granularity,
  );
  return {
    symbol: name,
    items: affected.map((item) => ({ key: itemKey(item), via: via.get(itemKey(item)) || null })),
    files: [...new Set(affected.map((item) => item.file))].filter((f) => f !== file),
    tests: affected.filter((item) => item.kind === "statement" && isTest(item.file)).map(itemKey),
    ms: Math.round(rounds.reduce((sum, round) => sum + round.ms, 0)),
    rounds: rounds.length,
  };
}

type FileRow = Awaited<ReturnType<typeof measure>> & (typeof samples)[number];
type SymbolRow = Awaited<ReturnType<typeof measureSymbol>> & { file: string };

function renderFileTable(rows: FileRow[]) {
  const header = [
    "sample",
    "kind",
    "direct: graph / `export {}` / delete",
    "closure: graph / `export {}` / delete",
    "only nerf / only graph",
    "test files",
    "reaches",
    "time (delete): direct / closure",
  ];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const onlyNerf = row.delete.closure.filter((f) => !row.graph.closure.includes(f));
    const onlyGraph = row.graph.closure.filter((f) => !row.delete.closure.includes(f));
    const reached = [...new Set([...row.delete.closure, ...row.graph.closure])];
    lines.push(
      `| \`${row.file}\` | ${row.kind} | ${row.graph.direct.length} / ${row.empty.direct.length} / ${row.delete.direct.length} | ${row.graph.closure.length} / ${row.empty.closure.length} / ${row.delete.closure.length} | ${onlyNerf.length} / ${onlyGraph.length} | ${row.delete.closure.filter(isTest).length} | ${shortWorkspaces(reached)} | ${(row.delete.directMs / 1000).toFixed(1)}s / ${(row.delete.closureMs / 1000).toFixed(0)}s (${row.delete.levelSizes.length} rounds) |`,
    );
  }
  return lines.join("\n");
}

function renderSymbolTable(files: FileRow[], declaration: SymbolRow[], member: SymbolRow[]) {
  const header = [
    "export",
    "whole file (graph): files / test files",
    "declaration-level: files / test files / tests / time",
    "member-level: files / test files / tests / time",
    "member-level reaches",
  ];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  const cell = (row: SymbolRow) =>
    `${row.files.length} / ${row.files.filter(isTest).length} / ${row.tests.length} / ${(row.ms / 1000).toFixed(0)}s`;
  for (const d of declaration) {
    const file = files.find((f) => f.file === d.file)!;
    const m = member.find((row) => row.file === d.file)!;
    lines.push(
      `| \`${d.symbol}\` (${file.kind}) | ${file.graph.closure.length} / ${file.graph.closure.filter(isTest).length} | ${cell(d)} | ${cell(m)} | ${shortWorkspaces(m.files)} |`,
    );
  }
  return lines.join("\n");
}

/** `os, dash · pkg shared` for the apps and packages whose non-test files are in `files`. */
function shortWorkspaces(files: string[]) {
  const all = workspaces(files.filter((f) => !isTest(f)));
  const apps = all.filter((w) => w.startsWith("apps/")).map((w) => w.slice(5));
  const packages = all.filter((w) => w.startsWith("packages/")).map((w) => w.slice(9));
  return (
    [apps.join(", "), packages.length ? `pkg ${packages.join(", ")}` : ""]
      .filter(Boolean)
      .join(" · ") || "—"
  );
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

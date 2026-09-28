// scripts/ts-affected/engine.ts — EXPERIMENT (tasks/complete/2026-09-28-typescript-change-detection.md): ask
// TypeScript what a change reaches. Nerf a file (or one declaration), re-run the tsc programs
// `pnpm typecheck` runs, and every file with a new error depends on what was nerfed. cli.ts holds
// the commands; this module holds the machinery.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export type Diagnostic = {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
};

export type Repo = {
  /** The checkout being measured: this one, or a lab checkout of an older commit. */
  root: string;
  programs: string[];
  /** Repo-relative file → the programs that read it (by `include` or by import). */
  programsByFile: Map<string, string[]>;
  /** Repo-relative file → the files that import or reference it, per `tsc --explainFiles`. */
  importersByFile: Map<string, Set<string>>;
  /** Errors before any nerf, keyed by `diagnosticKey`: a nerf's errors are the ones not in here. */
  baseline: Set<string>;
  msToLoad: number;
};

/**
 * The tsconfigs `pnpm typecheck` checks: every `tsc` call in each workspace's `typecheck` script,
 * and the root's `typecheck:specs` and `typecheck:configs`.
 */
function listPrograms(root: string) {
  const workspace = parseYaml(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as {
    packages: string[];
  };
  const rootScripts = readScripts(root, ".");
  const scripts = [
    { dir: ".", script: rootScripts["typecheck:specs"] },
    { dir: ".", script: rootScripts["typecheck:configs"] },
    ...workspace.packages.map((dir) => ({ dir, script: readScripts(root, dir).typecheck || "" })),
  ];
  return scripts.flatMap(({ dir, script }) =>
    script.split("&&").flatMap((call) => {
      const args = call.trim().split(/\s+/);
      if (args[0] !== "tsc") return [];
      const projects = args.flatMap((arg, i) => (args[i - 1] === "-p" ? [arg] : []));
      return (projects.length ? projects : ["tsconfig.json"]).map((project) =>
        path.join(dir, project.endsWith(".json") ? project : path.join(project, "tsconfig.json")),
      );
    }),
  );
}

function readScripts(root: string, dir: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")).scripts || {};
}

/**
 * One `tsc --explainFiles` run per program gives all three things a nerf needs: which files each
 * program reads, the import graph between them, and the errors that were already there.
 */
export async function loadRepo(root: string): Promise<Repo> {
  const started = performance.now();
  const programs = listPrograms(root);
  const runs = await pool(
    programs.map(
      (program) => () =>
        runTsc(root, ["-p", program, "--noEmit", "--pretty", "false", "--explainFiles"]),
    ),
  );
  const programsByFile = new Map<string, string[]>();
  const importersByFile = new Map<string, Set<string>>();
  const baseline = new Set<string>();
  runs.forEach(({ stdout }, i) => {
    let current = "";
    for (const line of stdout.split("\n")) {
      const diagnostic = parseDiagnosticLine(line);
      if (diagnostic) {
        baseline.add(diagnosticKey(diagnostic));
      } else if (/^\S/.test(line)) {
        current = line.trim();
        if (!isOwnSource(current)) continue;
        programsByFile.set(current, [...(programsByFile.get(current) || []), programs[i]]);
      } else if (isOwnSource(current)) {
        const importer = line.match(/ from file '([^']+)'/)?.[1];
        if (!importer) continue;
        importersByFile.set(current, (importersByFile.get(current) || new Set()).add(importer));
      }
    }
  });
  return {
    root,
    programs,
    programsByFile,
    importersByFile,
    baseline,
    msToLoad: performance.now() - started,
  };
}

/** Skips the lib files, node_modules and the "File is ECMAScript module because…" noise lines. */
function isOwnSource(file: string) {
  return /\.(c|m)?tsx?$/.test(file) && !file.includes("node_modules/") && !path.isAbsolute(file);
}

export type Edit = { file: string; content: string } | { file: string; deleted: true };

/**
 * Applies the edits (writing or deleting each file), re-checks `programs`, restores the files,
 * and returns the errors the baseline did not have. A round that adds edits to earlier ones only
 * needs the programs that read the newly edited files: every other program's errors are the
 * earlier rounds'.
 */
export async function checkWithEdits(repo: Repo, edits: Edit[], programs: string[]) {
  const started = performance.now();
  const originals = edits.map((edit) => ({
    path: path.join(repo.root, edit.file),
    content: readFileSync(path.join(repo.root, edit.file), "utf8"),
  }));
  pendingRestores.push(...originals);
  try {
    for (const edit of edits) {
      if ("deleted" in edit) rmSync(path.join(repo.root, edit.file));
      else writeFileSync(path.join(repo.root, edit.file), edit.content);
    }
    const runs = await pool(
      programs.map(
        (program) => () => runTsc(repo.root, ["-p", program, "--noEmit", "--pretty", "false"]),
      ),
    );
    const diagnostics = new Map<string, Diagnostic>();
    for (const { stdout } of runs) {
      for (const line of stdout.split("\n")) {
        const diagnostic = parseDiagnosticLine(line);
        if (diagnostic && !repo.baseline.has(diagnosticKey(diagnostic)))
          diagnostics.set(diagnosticKey(diagnostic), diagnostic);
      }
    }
    return { diagnostics: [...diagnostics.values()], programs, ms: performance.now() - started };
  } finally {
    restorePending();
  }
}

// A nerfed file must never outlive the run, even one killed with ctrl-c.
const pendingRestores: Array<{ path: string; content: string }> = [];
function restorePending() {
  for (const { path, content } of pendingRestores.splice(0)) writeFileSync(path, content);
}
process.on("exit", restorePending);
process.on("SIGINT", () => process.exit(130));

export type FileNerf = "empty" | "delete";

export function programsReading(repo: Repo, files: string[]) {
  return [...new Set(files.flatMap((file) => repo.programsByFile.get(file) || []))];
}

/**
 * The files with a new error once `files` are nerfed, checked in the programs that read `latest`:
 * the dependents of `latest`.
 */
async function fileDependents(repo: Repo, files: string[], latest: string[], strategy: FileNerf) {
  const result = await checkWithEdits(
    repo,
    files.map((file): Edit =>
      strategy === "delete" ? { file, deleted: true } : { file, content: "export {};\n" },
    ),
    programsReading(repo, latest),
  );
  // A file-less error (TS18003: a program lost every input) is no dependent.
  const dependents = [...new Set(result.diagnostics.map((d) => d.file))].filter(
    (file) => file && !files.includes(file),
  );
  return { ...result, dependents };
}

/**
 * The transitive dependents by nerfing: nerf everything found so far, one tsc round per level. A
 * broken import types its binding as an error (`any`), which silences everything past the
 * importer, so each round sees about one level further. `levels[1]` is the direct dependents.
 */
export async function fileClosure(repo: Repo, file: string, strategy: FileNerf) {
  const levels = [[file]];
  const rounds: Array<{ ms: number; codes: string[] }> = [];
  for (;;) {
    const round = await fileDependents(repo, levels.flat(), levels.at(-1)!, strategy);
    rounds.push({ ms: round.ms, codes: round.diagnostics.map((d) => d.code) });
    if (!round.dependents.length) return { levels, rounds };
    levels.push(round.dependents.sort());
  }
}

/** Direct importers per `tsc --explainFiles`. */
export function graphImporters(repo: Repo, file: string) {
  return [...(repo.importersByFile.get(file) || [])].sort();
}

/** Transitive importers per `tsc --explainFiles`, by level. */
export function graphClosure(repo: Repo, file: string) {
  const seen = new Set([file]);
  const levels = [[file]];
  for (;;) {
    const next = levels
      .at(-1)!
      .flatMap((f) => graphImporters(repo, f))
      .filter((f) => !seen.has(f));
    const unique = [...new Set(next)].sort();
    if (!unique.length) return levels;
    unique.forEach((f) => seen.add(f));
    levels.push(unique);
  }
}

function diagnosticKey(d: Diagnostic) {
  return `${d.file}:${d.line}:${d.column}:${d.code}`;
}

function parseDiagnosticLine(line: string): Diagnostic | undefined {
  const match = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (match)
    return {
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5],
    };
  const global = line.match(/^error (TS\d+): (.*)$/);
  if (global) return { file: "", line: 0, column: 0, code: global[1], message: global[2] };
}

async function runTsc(root: string, args: string[]) {
  const started = performance.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/.bin/tsc"), args, { cwd: root });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(output));
  });
  return { stdout, ms: performance.now() - started };
}

/** Runs the tasks a few at a time: tsgo is multi-threaded, so one per core would thrash. */
async function pool<T>(tasks: Array<() => Promise<T>>) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(2, Math.floor(availableParallelism() / 2)) },
    async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

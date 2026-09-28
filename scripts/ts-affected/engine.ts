// scripts/ts-affected/engine.ts — EXPERIMENT (tasks/typescript-change-detection.md): ask
// TypeScript what a change reaches. Nerf a file (or one declaration), re-run the tsc programs
// `pnpm typecheck` runs, and every file with a new error depends on what was nerfed. cli.ts holds
// the commands; this module holds the machinery.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export const root = path.resolve(import.meta.dirname, "../..");
const tsc = path.join(root, "node_modules/.bin/tsc");

export type Diagnostic = {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
};

export type Repo = {
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
export function listPrograms() {
  const workspace = parseYaml(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as {
    packages: string[];
  };
  const rootScripts = readScripts(".");
  const scripts = [
    { dir: ".", script: rootScripts["typecheck:specs"] },
    { dir: ".", script: rootScripts["typecheck:configs"] },
    ...workspace.packages.map((dir) => ({ dir, script: readScripts(dir).typecheck || "" })),
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

function readScripts(dir: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")).scripts || {};
}

/**
 * One `tsc --explainFiles` run per program gives all three things a nerf needs: which files each
 * program reads, the import graph between them, and the errors that were already there.
 */
export async function loadRepo(): Promise<Repo> {
  const started = performance.now();
  const programs = listPrograms();
  const runs = await pool(
    programs.map(
      (program) => () => runTsc(["-p", program, "--noEmit", "--pretty", "false", "--explainFiles"]),
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

export type Edit = { file: string; content: string | null };

/**
 * Applies the edits (`content: null` deletes the file), re-checks every program that reads an
 * edited file, restores the files, and returns the errors the baseline did not have.
 */
export async function checkWithEdits(repo: Repo, edits: Edit[]) {
  const programs = [...new Set(edits.flatMap((edit) => repo.programsByFile.get(edit.file) || []))];
  const started = performance.now();
  const originals = edits.map((edit) => ({
    file: edit.file,
    content: readFileSync(path.join(root, edit.file), "utf8"),
  }));
  pendingRestores.push(...originals);
  try {
    for (const edit of edits) {
      if (edit.content === null) rmSync(path.join(root, edit.file));
      else writeFileSync(path.join(root, edit.file), edit.content);
    }
    const runs = await pool(
      programs.map((program) => () => runTsc(["-p", program, "--noEmit", "--pretty", "false"])),
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
const pendingRestores: Array<{ file: string; content: string }> = [];
function restorePending() {
  for (const { file, content } of pendingRestores.splice(0))
    writeFileSync(path.join(root, file), content);
}
process.on("exit", restorePending);
process.on("SIGINT", () => process.exit(130));

export type FileNerf = "empty" | "delete";

export function nerfFile(file: string, strategy: FileNerf): Edit {
  return { file, content: strategy === "delete" ? null : "export {};\n" };
}

/** The files with a new error once `files` are nerfed: their direct dependents. */
export async function fileDependents(repo: Repo, files: string[], strategy: FileNerf) {
  const result = await checkWithEdits(
    repo,
    files.map((file) => nerfFile(file, strategy)),
  );
  const dependents = [...new Set(result.diagnostics.map((d) => d.file))].filter(
    (file) => !files.includes(file),
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
    const round = await fileDependents(repo, levels.flat(), strategy);
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

export function diagnosticKey(d: Diagnostic) {
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

async function runTsc(args: string[]) {
  const started = performance.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(tsc, args, { cwd: root });
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

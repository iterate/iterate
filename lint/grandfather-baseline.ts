// `pnpm lint:baseline` rewrites lint/grandfathered.json from the violations oxlint reports today:
//
//   pnpm lint:baseline                          drop the entries no report uses any more
//   pnpm lint:baseline --add iterate/<rule>     grandfather every current report of a rule, to arm it
//
// Without --add it only ever removes entries, so running it cannot grandfather a new violation.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  baselinePath,
  readBaseline,
  reportAllVariable,
  type GrandfatheredLines,
} from "./grandfather-rule.ts";

if (import.meta.main) {
  const { values } = parseArgs({
    options: { add: { type: "string", multiple: true, default: [] } },
  });
  const { root, lines: previous } = readBaseline();
  const next = nextBaseline(previous, reportedLines(root), values.add);
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  execFileSync(join(root, "node_modules/.bin/oxfmt"), [baselinePath], { cwd: root });
  for (const rule of Object.keys({ ...previous, ...next }).sort())
    console.log(`${rule}: ${count(previous[rule])} → ${count(next[rule])}`);
}

/** The baseline after keeping each previous entry that a current report still uses (each report
 * keeps at most one), and taking every current report of the rules in `add`. */
export function nextBaseline(
  previous: GrandfatheredLines,
  current: GrandfatheredLines,
  add: string[],
): GrandfatheredLines {
  const next: GrandfatheredLines = {};
  for (const rule of [...new Set([...Object.keys(previous), ...add])].sort()) {
    const files = add.includes(rule) ? current[rule] || {} : previous[rule]!;
    for (const path of Object.keys(files).sort()) {
      const kept = add.includes(rule)
        ? [...files[path]!]
        : keepOccurring(files[path]!, current[rule]?.[path] || []);
      if (kept.length) (next[rule] ||= {})[path] = kept.sort();
    }
  }
  return next;
}

/** Every report oxlint makes in the repository, grandfathered or not, as baseline entries. */
function reportedLines(root: string) {
  const lint = spawnSync(
    join(root, "node_modules/.bin/oxlint"),
    [".", "--threads", "1", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, [reportAllVariable]: "1" },
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  // oxlint exits 1 when it reports anything, and here it reports every grandfathered violation.
  if (lint.status !== 0 && lint.status !== 1) throw new Error(`oxlint failed:\n${lint.stderr}`);
  const { diagnostics } = JSON.parse(lint.stdout) as {
    diagnostics: { code: string; filename: string; labels: { span: { line: number } }[] }[];
  };
  const reported: GrandfatheredLines = {};
  const sources = new Map<string, string[]>();
  for (const { code, filename, labels } of diagnostics) {
    const rule = /^(.+)\((.+)\)$/.exec(code);
    const line = labels[0]?.span.line;
    if (!rule || !line) continue;
    let source = sources.get(filename);
    if (!source) {
      // The line terminators SourceCode.lines splits on, so texts match what the rule wrapper reads.
      source = readFileSync(join(root, filename), "utf8").split(/\r\n|\r|\n|\u2028|\u2029/);
      sources.set(filename, source);
    }
    ((reported[`${rule[1]}/${rule[2]}`] ||= {})[filename] ||= []).push(source[line - 1]!.trim());
  }
  return reported;
}

function keepOccurring(allowed: string[], occurring: string[]) {
  const left = new Map<string, number>();
  for (const text of occurring) left.set(text, (left.get(text) || 0) + 1);
  return allowed.filter((text) => {
    const n = left.get(text) || 0;
    left.set(text, n - 1);
    return n > 0;
  });
}

function count(files: Record<string, string[]> | undefined) {
  return Object.values(files || {}).reduce((sum, texts) => sum + texts.length, 0);
}

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Rule } from "eslint";
import type { StrictRule } from "./types.ts";

/** Suppress reports whose start line was last authored at or before the cutoff.
 * Uncommitted lines and lines without provable history are always checked.
 * Uses the linted source, so editor buffers and fixes retain correct line numbers.
 */
export function grandfatherRule({
  allowedUpTo,
  ...rule
}: StrictRule & { allowedUpTo: Date }): StrictRule {
  const cutoff = allowedUpTo.getTime();
  if (!Number.isFinite(cutoff))
    throw new Error("grandfatherRule requires a valid allowedUpTo date");

  return {
    ...rule,
    create(context) {
      let dates: Map<number, number> | undefined;
      const wrapped = Object.create(context, {
        report: {
          value(descriptor: Rule.ReportDescriptor) {
            const location =
              ("loc" in descriptor && descriptor.loc) ||
              ("node" in descriptor && descriptor.node.loc);
            const line = location && ("start" in location ? location.start.line : location.line);
            if (line) {
              dates ||= blameDates(context);
              const date = dates.get(line);
              if (date !== undefined && date <= cutoff) return;
            }
            context.report(descriptor);
          },
        },
      });
      return rule.create(wrapped);
    },
  };
}

function blameDates(context: Rule.RuleContext) {
  const dates = new Map<number, number>();
  const filename = context.physicalFilename;
  if (!filename || filename.startsWith("<")) return dates;
  const file = resolve(context.cwd, filename);
  let root = dirname(file);
  while (!existsSync(resolve(root, ".git"))) {
    const parent = dirname(root);
    if (root === parent) return dates;
    root = parent;
  }
  // Keep the encoding literal so both Git APIs return text rather than buffers.
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  } as const;
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], options);
  if (head.status === 1) return dates; // An unborn repository has no committed lines.
  if (head.error) throw head.error;
  if (head.status !== 0) throw new Error(`grandfatherRule: ${head.stderr}`);
  const path = relative(root, file);
  const tracked = execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", path], options);
  if (!tracked.trim()) return dates; // Includes staged additions as well as untracked files.
  const shallow =
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], options).trim() === "true";
  const blame = execFileSync("git", ["blame", "--line-porcelain", "--contents", "-", "--", path], {
    ...options,
    input: context.sourceCode.text,
  });
  let line = 0;
  let authorTime = Number.NaN;
  let uncommitted = false;
  let boundary = false;
  for (const entry of blame.split("\n")) {
    const header = /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(entry);
    if (header) {
      line = Number(header[2]);
      authorTime = Number.NaN;
      uncommitted = /^0+$/.test(header[1]);
      boundary = false;
    } else if (entry.startsWith("author-time ")) {
      authorTime = Number(entry.slice("author-time ".length)) * 1000;
    } else if (entry === "boundary") {
      boundary = true;
    } else if (entry.startsWith("\t") && !uncommitted && !(shallow && boundary)) {
      if (!Number.isFinite(authorTime))
        throw new Error(`grandfatherRule: missing blame author time for ${file}:${line}`);
      dates.set(line, authorTime);
    }
  }
  return dates;
}

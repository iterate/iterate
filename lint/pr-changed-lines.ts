import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { applyPatch, diffLines, parsePatch, reversePatch } from "diff";
import type { Rule } from "eslint";
import { z } from "zod";

/** One pinned PR diff per plugin load. Other runs keep using local blame. */
export const prChanges =
  process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GH_TOKEN
    ? await loadPrChanges()
    : null;

async function loadPrChanges() {
  const sha = z.string().regex(/^[a-f0-9]{40}$/);
  const event = z
    .object({
      repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
      pull_request: z.object({ base: z.object({ sha }), head: z.object({ sha }) }),
    })
    .parse(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")));
  const { base, head } = event.pull_request;
  const response = await fetch(
    `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${event.repository.full_name}/compare/${base.sha}...${head.sha}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github.diff",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`PR lint diff request failed: HTTP ${response.status}`);
  const diff = await response.text();
  if (diff.trim() && !diff.startsWith("diff --git "))
    throw new Error("GitHub did not return a PR diff");
  return { head: head.sha, patches: parsePatch(diff) };
}

/** Reverse the PR patch to recover original text, then compare against each autofix pass. */
export function prChangedLines(context: Rule.RuleContext, pr: NonNullable<typeof prChanges>) {
  const filename = context.physicalFilename;
  if (!filename || filename.startsWith("<")) return null;
  const file = resolve(context.cwd, filename);
  // Literal encoding keeps Git output typed as text.
  const options = {
    cwd: dirname(file),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  } as const;
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], options).trimEnd();
  const patch = pr.patches.find((patch) => patch.newFileName === `b/${prefix}${basename(file)}`);
  const added = new Set<number>();
  if (!patch || !patch.hunks.length) return added;
  const head = execFileSync("git", ["show", `${pr.head}:${prefix}${basename(file)}`], options);
  const before = applyPatch(head, reversePatch(patch));
  if (before === false) throw new Error(`PR lint diff does not match ${filename}`);
  const changes = diffLines(before, context.sourceCode.text, { timeout: 1000 });
  if (!changes) throw new Error(`PR lint diff timed out for ${filename}`);
  let line = 1;
  for (const change of changes) {
    if (change.removed) continue;
    if (change.added) {
      for (let offset = 0; offset < change.count; offset++) added.add(line + offset);
    }
    line += change.count;
  }
  return added;
}

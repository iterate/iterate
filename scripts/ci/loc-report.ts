import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, matchesGlob } from "node:path";

import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";

/**
 * Array order is match order: first-match-wins, most-specific globs first, so
 * every changed file lands in exactly one group and Total is honest.
 * `priority` is display order (lower = higher in the table): what a reviewer
 * cares about most goes first - product code, then UI, then tests; supporting
 * churn (CI, config, docs) after; generated noise last.
 */
export const groups: Array<{ name: string; glob: string; priority: number }> = [
  {
    name: "Generated",
    glob: "{pnpm-lock.yaml,**/.generated/**,**/generated/**,**/*.generated.*}",
    priority: 8,
  },
  {
    name: "Tests",
    glob: "{**/*.{test,spec}.*,**/{e2e,tests,__tests__,test-helpers}/**}",
    priority: 3,
  },
  { name: "UI components", glob: "{packages/ui/**,**/components/**}", priority: 2 },
  { name: "Docs", glob: "{docs/**,**/*.md}", priority: 6 },
  { name: "CI & scripts", glob: "{.depot/**,.github/**,scripts/**,**/scripts/**}", priority: 4 },
  { name: "Config", glob: "**/*.{json,jsonc,json5,yml,yaml,toml}", priority: 5 },
  { name: "Product", glob: "{apps,packages}/**", priority: 1 },
  // "Other" is the code-level fallback for anything unmatched (globs skip dotfiles, so a
  // literal `**` catch-all wouldn't actually catch everything).
  { name: "Other", glob: "", priority: 7 },
];

/** markdownAnnotator label for the managed PR-body section. */
const bodySectionLabel = "loc-report";

export type ChangedFile = {
  path: string;
  previousPath: string;
  added: number;
  removed: number;
  binary: boolean;
};

/** Parses `git diff --numstat -z -M` output (NUL-separated, rename-aware). */
export function parseNumstat(raw: string): ChangedFile[] {
  const tokens = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue;
    const [added, removed, ...pathParts] = tokens[i].split("\t");
    const inlinePath = pathParts.join("\t");
    // Renamed entries have an empty inline path followed by two NUL-terminated paths.
    const previousPath = inlinePath || tokens[++i];
    const path = inlinePath || tokens[++i];
    const binary = added === "-";
    files.push({
      path,
      previousPath,
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
    });
  }
  return files;
}

const gitMaxBuffer = 64 * 1024 * 1024;

/**
 * Changed files between merge-base(base, head) and head, with added/removed
 * counted as SLOC: blank lines never count, and for JS-ish files line and
 * block comments are stripped first. Counts come from diffing the
 * stripped before/after contents, so multiline comment blocks and
 * comment-only changes fall out naturally.
 */
export function getChangedFiles(baseRef: string, headRef: string): ChangedFile[] {
  const raw = execFileSync("git", ["diff", "--numstat", "-z", "-M", `${baseRef}...${headRef}`], {
    encoding: "utf8",
    maxBuffer: gitMaxBuffer,
  });
  const mergeBase = execFileSync("git", ["merge-base", baseRef, headRef], {
    encoding: "utf8",
  }).trim();
  return parseNumstat(raw).map((file) => {
    if (file.binary) return file;
    const before = significantLines(gitShow(mergeBase, file.previousPath), file.previousPath);
    const after = significantLines(gitShow(headRef, file.path), file.path);
    return { ...file, ...slocDiffCounts(before, after) };
  });
}

const jsExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function significantLines(content: string, path: string) {
  const stripped = jsExtensions.has(extname(path)) ? stripJsComments(content) : content;
  return stripped
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** Contents of `path` at `ref`, or "" when it doesn't exist there (added/deleted files). */
function gitShow(ref: string, path: string) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function slocDiffCounts(before: string, after: string) {
  if (before === after) return { added: 0, removed: 0 };
  const dir = mkdtempSync(join(tmpdir(), "loc-report-"));
  try {
    writeFileSync(join(dir, "before"), before && `${before}\n`);
    writeFileSync(join(dir, "after"), after && `${after}\n`);
    let out = "";
    try {
      out = execFileSync(
        "git",
        ["diff", "--no-index", "--numstat", "--", join(dir, "before"), join(dir, "after")],
        { encoding: "utf8", maxBuffer: gitMaxBuffer },
      );
    } catch (error) {
      // git diff --no-index exits 1 when the files differ; the numstat is still on stdout
      out = (error as { stdout?: string }).stdout || "";
    }
    const [added, removed] = out.split("\t");
    return { added: Number(added) || 0, removed: Number(removed) || 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Removes line (`//`) and block comments, tracking string/template-literal
 * state so things like "http://..." survive. Known limitation: regex
 * literals aren't tracked, so a regex containing `//` or `/*` will eat the
 * rest of its line (or until a block-comment closer) - rare enough to ignore for now.
 * Newlines inside block comments are preserved so line structure survives.
 */
export function stripJsComments(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" = "code";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        i--;
        continue;
      }
      if (char === "/" && next === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") result += "\n";
          i++;
        }
        i++;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      result += char;
      continue;
    }
    // inside a string/template literal
    if (char === "\\") {
      result += char + (next || "");
      i++;
      continue;
    }
    const closed =
      (state === "single" && (char === "'" || char === "\n")) ||
      (state === "double" && (char === '"' || char === "\n")) ||
      (state === "template" && char === "`");
    if (closed) state = "code";
    result += char;
  }
  return result;
}

export type GroupRow = {
  name: string;
  priority: number;
  files: number;
  added: number;
  removed: number;
};

export function computeReport(files: ChangedFile[]) {
  const rows: GroupRow[] = groups.map((group) => ({
    name: group.name,
    priority: group.priority,
    files: 0,
    added: 0,
    removed: 0,
  }));
  for (const file of files) {
    const index = groups.findIndex((group) => group.glob && matchesGlob(file.path, group.glob));
    const row = rows[index === -1 ? rows.length - 1 : index];
    row.files += 1;
    row.added += file.added;
    row.removed += file.removed;
  }
  const total: GroupRow = {
    name: "Total",
    priority: Infinity,
    files: files.length,
    added: rows.reduce((sum, row) => sum + row.added, 0),
    removed: rows.reduce((sum, row) => sum + row.removed, 0),
  };
  const populated = rows.filter((row) => row.files > 0);
  populated.sort((a, b) => a.priority - b.priority);
  return { rows: populated, total };
}

/**
 * Renders the report as a markdown table mimicking GitHub's own diffstat: +added,
 * -removed, and a five-square bar. Squares fill proportionally to the group's
 * share of the largest group's churn, split green/red by its add/remove ratio.
 */
export function renderTable(report: ReturnType<typeof computeReport>) {
  // Always signed, even +0/-0, matching GitHub's own diffstat.
  const count = (n: number, sign: "+" | "-") => `${sign}${Math.abs(n).toLocaleString("en-US")}`;
  const maxChurn = Math.max(...report.rows.map((row) => row.added + row.removed), 1);
  const bar = (row: GroupRow) => {
    const churn = row.added + row.removed;
    if (churn === 0) return "⬜⬜⬜⬜⬜";
    const filled = row.name === "Total" ? 5 : Math.max(1, Math.round((5 * churn) / maxChurn));
    const green = Math.round((filled * row.added) / churn);
    return "🟩".repeat(green) + "🟥".repeat(filled - green) + "⬜".repeat(5 - filled);
  };
  const line = (row: GroupRow, wrap: (text: string) => string) => {
    const changes = `${count(row.added, "+")} ${count(row.removed, "-")}`;
    return `| ${wrap(row.name)} | ${wrap(changes)} ${bar(row)} |`;
  };
  return [
    "| Group | Changes |",
    "| --- | --- |",
    ...report.rows.map((row) => line(row, (text) => text)),
    line(report.total, (text) => `**${text}**`),
  ].join("\n");
}

export function renderBodySection(
  report: ReturnType<typeof computeReport>,
  baseSha: string,
  headSha: string,
) {
  return [
    renderTable(report),
    "",
    `<sub>Source lines changed (blank lines and JS comments ignored) between ${baseSha.slice(0, 7)} and ${headSha.slice(0, 7)}, bucketed first-match-wins into the groups defined in \`scripts/ci/loc-report.ts\`.</sub>`,
  ].join("\n");
}

function ensureCommitAvailable(sha: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["fetch", "--no-tags", "origin", sha], { stdio: "inherit" });
  }
}

export async function postLocReport() {
  const payload = process.env.GITHUB_EVENT_PATH ? readEventPayload() : undefined;
  const pullRequest = payload?.pull_request;

  if (!pullRequest?.base?.sha || !pullRequest.head?.sha) {
    const baseRef = process.argv[2] || "origin/main";
    const headRef = process.argv[3] || "HEAD";
    console.log(`No pull request context - printing report for ${baseRef}...${headRef}\n`);
    const report = computeReport(getChangedFiles(baseRef, headRef));
    console.log(renderTable(report));
    return;
  }

  const baseSha = pullRequest.base.sha;
  const headSha = pullRequest.head.sha;
  ensureCommitAvailable(baseSha);
  ensureCommitAvailable(headSha);
  const report = computeReport(getChangedFiles(baseSha, headSha));
  const section = renderBodySection(report, baseSha, headSha);
  console.log(section);

  const github = getOctokit();
  const repo = getRepo();
  // Fetch the body fresh rather than trusting the event payload - the PR
  // description may have been edited since the event fired.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pullRequest.number });
  const body = markdownAnnotator(pr.body || "", bodySectionLabel).update(section);
  await github.rest.pulls.update({ ...repo, pull_number: pullRequest.number, body });
  console.log(`Updated LOC report section in PR #${pullRequest.number} body`);
}

if (isMainModule(import.meta.url)) {
  await postLocReport();
}

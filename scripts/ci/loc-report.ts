import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";

import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getOctokit, getRepo, readEventPayload } from "./github.ts";

/**
 * Ordered, first-match-wins. Every changed file lands in the first group whose
 * glob matches it, so the rows partition the diff exactly and Total is honest.
 */
export const groups: Array<{ name: string; glob: string }> = [
  { name: "Generated", glob: "{pnpm-lock.yaml,**/.generated/**,**/generated/**,**/*.generated.*}" },
  { name: "Tests", glob: "{**/*.{test,spec}.*,**/{e2e,tests,__tests__,test-helpers}/**}" },
  { name: "UI components", glob: "{packages/ui/**,**/components/**}" },
  { name: "Docs", glob: "{docs/**,**/*.md}" },
  { name: "CI & scripts", glob: "{.depot/**,.github/**,scripts/**,**/scripts/**}" },
  { name: "Config", glob: "**/*.{json,jsonc,json5,yml,yaml,toml}" },
  { name: "Product", glob: "{apps,packages}/**" },
  // "Other" is the code-level fallback for anything unmatched (globs skip dotfiles, so a
  // literal `**` catch-all wouldn't actually catch everything).
  { name: "Other", glob: "" },
];

const commentMarker = "<!-- iterate-loc-report -->";

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

export function getChangedFiles(baseRef: string, headRef: string): ChangedFile[] {
  const raw = execFileSync("git", ["diff", "--numstat", "-z", "-M", `${baseRef}...${headRef}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseNumstat(raw);
}

export type GroupRow = { name: string; files: number; added: number; removed: number };

export function computeReport(files: ChangedFile[]) {
  const rows: GroupRow[] = groups.map((group) => ({
    name: group.name,
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
    files: files.length,
    added: rows.reduce((sum, row) => sum + row.added, 0),
    removed: rows.reduce((sum, row) => sum + row.removed, 0),
  };
  return { rows: rows.filter((row) => row.files > 0), total };
}

/**
 * Renders the report as a ```diff code block - the only way GitHub markdown
 * gives us colors. Rows are prefixed +/- by net sign so they render green/red.
 */
export function renderTable(report: ReturnType<typeof computeReport>) {
  const cells = [
    ["Group", "Files", "Added", "Removed", "Net"],
    ...[...report.rows, report.total].map((row) => {
      const net = row.added - row.removed;
      return [
        row.name,
        String(row.files),
        `+${row.added}`,
        `-${row.removed}`,
        net > 0 ? `+${net}` : String(net),
      ];
    }),
  ];
  const widths = cells[0].map((_, column) => Math.max(...cells.map((row) => row[column].length)));
  const lines = cells.map((row, rowIndex) => {
    const body = row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column] + 2),
      )
      .join("");
    if (rowIndex === 0) return `  ${body}`;
    const net = Number(row[4]);
    const prefix = net > 0 ? "+" : net < 0 ? "-" : " ";
    return `${prefix} ${body}`;
  });
  return ["```diff", ...lines, "```"].join("\n");
}

function renderComment(report: ReturnType<typeof computeReport>, baseSha: string, headSha: string) {
  return [
    "### LOC report",
    commentMarker,
    "",
    renderTable(report),
    "",
    `<sub>Lines changed between ${baseSha.slice(0, 7)} and ${headSha.slice(0, 7)}, bucketed first-match-wins into the groups defined in \`scripts/ci/loc-report.ts\`.</sub>`,
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
  const body = renderComment(report, baseSha, headSha);
  console.log(body);

  const github = getOctokit();
  const repo = getRepo();
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: pullRequest.number,
    per_page: 100,
  });
  const existing = comments.find((comment) => comment.body?.includes(commentMarker));
  if (existing) {
    await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
    console.log(`Updated existing LOC report comment ${existing.id}`);
  } else {
    const { data: created } = await github.rest.issues.createComment({
      ...repo,
      issue_number: pullRequest.number,
      body,
    });
    console.log(`Created LOC report comment ${created.id}`);
  }
}

if (isMainModule(import.meta.url)) {
  await postLocReport();
}

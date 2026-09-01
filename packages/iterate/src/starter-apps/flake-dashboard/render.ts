import type { Project } from "../../sdk.ts";
import type { FlakeDashboardRenderResult, FlakeDashboardState } from "./contract.ts";

const DASHBOARD_MARKER = "<!-- iterate-flake-dashboard -->";

/**
 * Upsert the GitHub "Flake dashboard" issue from folded state. Mechanical by
 * design (the AI-linter publication stance): all decisions were made when the
 * events reduced. The processor is the single writer, so a plain body
 * overwrite is race-free; the marker plus remembered issue number make the
 * upsert idempotent across retried renders.
 */
export async function renderFlakeDashboardIssue(
  itx: Project,
  state: FlakeDashboardState,
): Promise<Extract<FlakeDashboardRenderResult, { status: "succeeded" }>> {
  const config = state.birthCertificate?.config;
  if (config === undefined) throw new Error("Flake dashboard has no birth certificate.");

  const repos = await itx.repos.list();
  const links = await Promise.all(
    repos.map(async ({ path }) => (await itx.repos.get(path).processor.snapshot()).state.github),
  );
  const link = links.find(
    (candidate) =>
      candidate !== null &&
      candidate.owner === config.repository.owner &&
      candidate.repo === config.repository.repo,
  );
  if (link === null || link === undefined) {
    throw new Error(
      `No linked GitHub connection for ${config.repository.owner}/${config.repository.repo}; ` +
        "link a repo to that repository before the dashboard can render.",
    );
  }
  const octokit = itx.integrations.github.get(link.connection).octokit;
  const params = { owner: config.repository.owner, repo: config.repository.repo };
  const body = renderBody(state);

  const rememberedIssueNumber = state.render?.issueNumber || null;
  if (rememberedIssueNumber !== null) {
    const updated = await octokit.rest.issues.update({
      ...params,
      issue_number: rememberedIssueNumber,
      body,
      title: config.issueTitle,
    });
    return {
      status: "succeeded",
      issueNumber: rememberedIssueNumber,
      issueUrl: updated.data.html_url,
    };
  }

  // First render (or state predating a remembered number): find by marker
  // before creating — the marker, not the title, is authority, so a human
  // opening a same-titled issue cannot capture the dashboard.
  const issues = await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    ...params,
    state: "open",
    per_page: 100,
  });
  const existing = issues.find((issue) => issue.body?.includes(DASHBOARD_MARKER) === true);
  if (existing !== undefined) {
    await octokit.rest.issues.update({
      ...params,
      issue_number: existing.number,
      body,
      title: config.issueTitle,
    });
    return { status: "succeeded", issueNumber: existing.number, issueUrl: existing.html_url };
  }
  const created = await octokit.rest.issues.create({
    ...params,
    title: config.issueTitle,
    body,
  });
  return { status: "succeeded", issueNumber: created.data.number, issueUrl: created.data.html_url };
}

function renderBody(state: FlakeDashboardState): string {
  const tests = Object.entries(state.tests).sort(([a], [b]) => a.localeCompare(b));
  const lastRecordedAt = tests
    .map(([, test]) => test.lastRecordedAt)
    .sort()
    .at(-1);
  const rows = tests.map(([name, test]) => {
    const gated = test.counts.pass + test.counts.flakeFail;
    const rate = gated === 0 ? "—" : `${Math.round((test.counts.flakeFail / gated) * 100)}%`;
    const streak =
      test.defaultBranchStreak === null
        ? "—"
        : `${test.defaultBranchStreak.runs}× ${test.defaultBranchStreak.outcome}`;
    return [
      `\`${name}\``,
      `\`/${test.pattern}/\``,
      test.lanes.join(", "),
      String(gated + test.counts.unexpectedError),
      rate,
      test.lastFlakeAt || "never",
      streak,
      test.proposed.length === 0 ? "" : test.proposed.map((p) => p.split(":")[0]).join(", "),
    ].join(" | ");
  });
  return [
    DASHBOARD_MARKER,
    "Per-test outcomes of every [`createFlake`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/flake-test.ts)-wrapped test, folded from CI-reported runs. Maintained automatically — edits to this body will be overwritten.",
    "",
    "test | allowed pattern | lanes | runs | flake rate | last flake | default-branch streak | proposed",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...(rows.length === 0 ? ["_no flake tests recorded yet_ | | | | | | |"] : rows),
    "",
    `_Last recorded outcome: ${lastRecordedAt || "none"}._`,
  ].join("\n");
}

// THE FLAKE DASHBOARD'S WRITER: reads the flake records and suite summaries of CI's recent test
// runs from R2 (./evidence.ts), computes issue #2580's body from them (./dashboard.ts), and
// rewrites the issue when the body changed. `.depot/workflows/flake-dashboard.yml` runs it every
// hour. Nothing is kept between runs.
//
//   node scripts/ci/flake-dashboard/update.ts --dry-run
//
// --dry-run prints the body instead of writing the issue. The bucket is read with its account's
// Cloudflare API token (envs.ts `ciBucketEnvs`). The issue is written as the iterate GitHub App, the
// platform's own, with an installation token that can only write issues in this repository
// (../iterate-app-token.ts). The Depot app's job token has no Issues permission.
import type { Octokit } from "@octokit/rest";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { ciBucketEnvs } from "../../../envs.ts";
import { dopplerSecret } from "../../lib/env-context.ts";
import { createOctokit } from "../github.ts";
import { iterateAppFromPrd, iterateAppToken } from "../iterate-app-token.ts";
import { DASHBOARD_MARKER, renderDashboard } from "./dashboard.ts";
import { readSuiteRuns } from "./evidence.ts";

/** Reads CI's recent flake records and suite summaries from R2 and rewrites the flake dashboard
 *  issue when its body changed. */
export default async function update(
  options: {
    /** Print the body instead of writing the issue. */
    dryRun?: boolean;
  } = {},
) {
  const dryRun = options.dryRun ?? false;
  const repository = process.env.GITHUB_REPOSITORY || "iterate/iterate";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  const bucket = ciBucketEnvs.ci;
  const app = await iterateAppToken({
    ...(await iterateAppFromPrd()),
    owner,
    repositories: [repo],
    permissions: { issues: "write" },
  });
  console.log(
    `[flake-dashboard] iterate app token for ${app.repositories.join(", ")}: ${JSON.stringify(app.permissions)}`,
  );
  const github = createOctokit(app.token);

  const runs = await readSuiteRuns({
    accountId: bucket.cloudflareAccountId,
    bucketName: bucket.bucketName,
    apiToken: dopplerSecret(bucket.dopplerProject, bucket.dopplerConfig, "CLOUDFLARE_API_TOKEN"),
    now: new Date(),
  });
  const suites = [...new Set(runs.map((run) => run.suite))].sort();
  console.log(
    `[flake-dashboard] read ${runs.length} suite runs (${suites
      .map((suite) => {
        const ofSuite = runs.filter((run) => run.suite === suite);
        return `${suite}: ${ofSuite.filter((run) => run.main).length} main, ${ofSuite.filter((run) => !run.main).length} other, ${ofSuite.filter((run) => run.summary).length} summaries`;
      })
      .join("; ")})`,
  );
  const body = renderDashboard(runs, { owner, repo });
  const issue = await findDashboardIssue(github, { owner, repo });
  if (issue && issue.body === body) console.log(`[flake-dashboard] #${issue.number} is current`);
  else if (dryRun)
    console.log(
      `[flake-dashboard] dry run: would ${issue ? `rewrite #${issue.number}` : "open the dashboard issue"}`,
    );
  else if (issue) {
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, body });
    console.log(`[flake-dashboard] rewrote ${issue.html_url}`);
  } else {
    const created = await github.rest.issues.create({
      owner,
      repo,
      title: "Flake dashboard",
      body,
    });
    console.log(`[flake-dashboard] opened ${created.data.html_url}`);
  }
  if (dryRun) console.log(`[flake-dashboard] the body:\n${body}`);
}

/** The open issue whose body starts with the dashboard marker, whatever its title. */
async function findDashboardIssue(github: Octokit, repository: { owner: string; repo: string }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository,
    state: "open",
    per_page: 100,
  });
  return issues.find((issue) => !issue.pull_request && issue.body?.startsWith(DASHBOARD_MARKER));
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "flake-dashboard-update" }).run();

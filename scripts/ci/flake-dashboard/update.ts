// THE FLAKE DASHBOARD'S WRITER: reads the flake records and suite summaries of CI's recent test
// runs from R2 (./evidence.ts), computes issue #2580's body from them (./dashboard.ts), and
// rewrites the issue when the body changed. `.depot/workflows/flake-dashboard.yml` runs it every
// hour. Nothing is kept between runs.
//
//   node scripts/ci/flake-dashboard/update.ts --dry-run
//
// --dry-run prints the body instead of writing the issue. The bucket is read with its account's
// Cloudflare API token (envs.ts `ciBucketEnvs`). The issue is written as the iterate GitHub App, the
// platform's own: the writer takes the App's id and key from prd's configuration (Doppler os/prd's
// APP_CONFIG `integrations.github`) and mints an installation token that can only write issues in
// this repository. The Depot app's job token has no Issues permission.
import { createSign } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { parseAppConfig } from "../../../apps/os/src/app-config.ts";
import { ciBucketEnvs, getEnv, OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { dopplerSecret, resolveEnvContext } from "../../lib/env-context.ts";
import { createOctokit } from "../github.ts";
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
  const prd = await resolveEnvContext({
    env: getEnv("prd", osEnvs),
    dopplerProject: OS_DOPPLER_PROJECT,
  });
  const iterateApp = parseAppConfig({
    APP_CONFIG: prd.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: prd.secrets.APP_CONFIG_SECRETS__KEY,
  }).integrations.github;
  if (!iterateApp)
    throw new Error(
      "prd's APP_CONFIG has no integrations.github: the dashboard is the App's to write",
    );
  const app = await iterateAppIssuesToken({
    appId: iterateApp.appId,
    privateKey: iterateApp.privateKey.exposeSecret(),
    owner,
    repo,
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

/**
 * An installation token of the iterate GitHub App, narrowed to writing issues in this one
 * repository.
 */
export async function iterateAppIssuesToken(input: {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // GitHub App JWT: RS256, issued a minute back for clock drift, valid for less than ten minutes.
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iat: now - 60,
    exp: now + 540,
    iss: input.appId,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(input.privateKey, "base64url");
  const github = async (path: string, body?: object) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${unsigned}.${signature}`,
        "x-github-api-version": "2022-11-28",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const installation = z
    .object({ id: z.number() })
    .parse(await github(`/repos/${input.owner}/${input.repo}/installation`));
  const access = z
    .object({
      token: z.string().min(1),
      permissions: z.record(z.string(), z.string()),
      repositories: z.array(z.object({ name: z.string() })),
    })
    .parse(
      await github(`/app/installations/${installation.id}/access_tokens`, {
        repositories: [input.repo],
        permissions: { issues: "write" },
      }),
    );
  return {
    token: access.token,
    permissions: access.permissions,
    repositories: access.repositories.map(({ name }) => name),
  };
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

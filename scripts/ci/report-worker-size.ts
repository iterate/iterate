/**
 * Publish the deployed worker's bundle size as a `worker-size/<app>` commit
 * status on the deployed sha.
 *
 * Main deploy workflows (.depot/workflows/deploy-*.yml) tee their
 * `pnpm run-script deploy` output to a log file and run this afterwards; PR
 * preview runs (scripts/preview/preview.ts) read the newest status back off
 * main to render the "vs main" size delta in the PR-body preview table.
 *
 * Env: APP_SLUG, DEPLOY_LOG_FILE, DEPLOY_SHA (the checked-out sha that was
 * actually deployed — NOT the workflow trigger's GITHUB_SHA, which diverges
 * on a workflow_dispatch with a custom ref), GITHUB_REPOSITORY, and
 * GITHUB_TOKEN.
 */
import { readFileSync } from "node:fs";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import {
  formatWorkerSizeStatusDescription,
  parseWorkerSizeFromDeployOutput,
  workerSizeStatusContext,
} from "../preview/worker-size.ts";
import { getOctokit, getRepo, getRunUrl } from "./github.ts";

export async function reportWorkerSize(params: {
  appSlug: string;
  deployLogFile: string;
  sha: string;
}) {
  const deployOutput = readFileSync(params.deployLogFile, "utf8");
  const size = parseWorkerSizeFromDeployOutput(deployOutput);
  if (!size) {
    throw new Error(
      `No "Total Upload: … KiB / gzip: … KiB" line in ${params.deployLogFile} — did wrangler's output format change?`,
    );
  }

  const description = formatWorkerSizeStatusDescription(size);
  await getOctokit().rest.repos.createCommitStatus({
    ...getRepo(),
    sha: params.sha,
    state: "success",
    context: workerSizeStatusContext(params.appSlug),
    description,
    target_url: getRunUrl(),
  });
  console.log(
    `published ${workerSizeStatusContext(params.appSlug)} on ${params.sha.slice(0, 7)}: ${description}`,
  );
}

function readOption(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  await reportWorkerSize({
    appSlug: readOption("APP_SLUG"),
    deployLogFile: readOption("DEPLOY_LOG_FILE"),
    sha: readOption("DEPLOY_SHA"),
  });
}

if (isMainModule(import.meta.url)) {
  await main();
}

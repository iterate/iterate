// Prd post-deploy check (deploy-os.yml, the deploy job's step right after every prd deploy): wait
// (≤ 60 s) for `/version` to name a version other than the one live before the deploy, so the hosts
// are read on the new one, then one GET of each production project host, four tries 10 s apart while
// it looks down. A `/version` that never moves, or a host still answering 421 or 5xx or not at all,
// pages #error-pulse and fails the workflow: every project host can answer 421 while /version, the
// OAuth metadata smokes and the fault alarm (a 421 is no error) stay green. Faults on the new version
// are the prd fault alarm's (scripts/ci/prd-fault-alarm.ts, every 15 minutes).
//
// One page while the hosts are down (./slack.ts): a failing check edits the open page with what is
// down now and how many deploys it has failed since; the next passing check resolves it. A check that
// paged or edited says `paged=true` in its step's outputs, so the deploy's notify job does not page
// the same failure again (docs/depot-ci.md#slack-channels).
// READ-ONLY: `/version` and page GETs — it never creates a project, a user or an account.
//
//   node scripts/ci/prd-post-deploy-check.ts check [--previous-version <id>] [--dry-run] [--test-run]
//
// `--dry-run` prints the page and posts nothing; `--test-run` posts what the check would, marked 🧪,
// to #ci, and reads no page.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { osEnvs } from "../../envs.ts";
import { getSlackClient, keepPage, pageText, resolvedText, slackChannelIds } from "./slack.ts";

/** Production's project hosts people rely on: the iterate project's apex (envs.ts
 *  `osEnvs.prd.projectWildcard`) and projects' own custom hostnames, which live in the control plane
 *  (apps/os src/project/custom-hostnames.ts) — named here, since this check reads nothing but pages. */
export const PRD_PROJECT_HOST_URLS = [
  osEnvs.prd!.projectWildcard!.hostname,
  "garple.com",
  "lispwoso.com",
  "templestein.com",
].map((hostname) => `https://${hostname}/`);

/** `<version id> <origin>` (apps/os/src/worker.ts): the Cloudflare version prd serves. */
const VERSION_URL = `${osEnvs.prd!.baseUrl}/version`;

/** Waits for `/version` to name a version other than --previous-version (the id it named before the
 *  deploy; empty when it did not answer then), then GETs each production project host. */
export async function check(
  options: { previousVersion?: string; dryRun?: boolean; testRun?: boolean } = {},
) {
  const liveVersion = await readNewVersion(options.previousVersion);
  const hosts = await Promise.all(PRD_PROJECT_HOST_URLS.map(readHost));
  const findings = postDeployFindings({
    previousVersion: options.previousVersion,
    liveVersion,
    hosts,
  });
  console.log(JSON.stringify({ previousVersion: options.previousVersion, liveVersion, hosts }));
  const reading = {
    findings,
    liveVersion,
    sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runUrl: z.string().parse(process.env.DEPOT_JOB_URL),
    now: new Date(),
  };
  if (options.dryRun) console.log(postDeployTestText(reading));
  else if (options.testRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#ci"],
      text: postDeployTestText(reading),
    });
  else {
    const step = await reportPostDeploy(getSlackClient(), reading);
    console.log(`[prd-post-deploy-check] ${step}`);
    if ((step === "post" || step === "edit") && process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, "paged=true\n");
  }
  if (findings.length > 0) throw new Error(`prd post-deploy check failed:\n${findings.join("\n")}`);
  return `${osEnvs.prd!.workerName} version ${liveVersion} is live and every project host answers`;
}

/** What is wrong after a deploy, or nothing when `/version` names a new version and every project
 *  host answers: `/version` still naming the previous version (or not answering), and each host that
 *  is down. Pure. */
export function postDeployFindings(input: {
  previousVersion?: string;
  /** What `/version` last named, undefined when it never answered 200. */
  liveVersion?: string;
  hosts: { url: string; status: number }[];
}): string[] {
  const versionLine = !input.liveVersion
    ? `${VERSION_URL} did not answer 200`
    : input.liveVersion === input.previousVersion &&
      `${VERSION_URL} still names \`${input.liveVersion.slice(0, 8)}\`, the version live before the deploy`;
  const down = input.hosts
    .filter((host) => hostIsDown(host.status))
    .map((host) =>
      host.status
        ? `the project host ${host.url} answered ${host.status}`
        : `the project host ${host.url} did not answer`,
    );
  return [...(versionLine ? [versionLine] : []), ...down];
}

/** The page while the hosts are down: what is down after the deploy at `sha`, and since which
 *  commit and how many deploys the check has failed. */
export type PostDeployPage = {
  findings: string[];
  sha: string;
  since: string;
  deploys: number;
  runUrl: string;
};

const MARKER = "prd post-deploy check failed after";

/** The page while the hosts are down. Pure. */
export function postDeployPageText(page: PostDeployPage, testRun: boolean) {
  const worker = osEnvs.prd!.workerName;
  const deploys = page.deploys === 1 ? "1 deploy" : `${page.deploys} deploys`;
  return pageText({
    what: `${MARKER} the ${worker} deploy at ${page.sha.slice(0, 7)}`,
    impact: `${page.findings.join("; ")}; failing since ${page.since.slice(0, 7)}, ${deploys}`,
    action: `read the check's output in the run, then roll back ${worker} or fix forward`,
    link: page.runUrl,
    testRun,
  });
}

/** Since which commit and over how many deploys the open page says the check has failed. Pure. */
export function readPostDeployPage(text: string) {
  const [, since = "", deploys = "0"] = /failing since (\w+), (\d+) deploys?/.exec(text) || [];
  return { since, deploys: Number(deploys) };
}

type PostDeployReading = {
  findings: string[];
  liveVersion?: string;
  sha: string;
  runUrl: string;
  now: Date;
};

const passedWhy = (reading: PostDeployReading) =>
  `every project host answers on \`${(reading.liveVersion || "").slice(0, 8)}\``;

/** This reading's page, carrying forward since when and how many deploys the open page counted, or
 *  undefined when the check passed. Pure. */
export function postDeployPage(reading: PostDeployReading, openText: string | undefined) {
  if (reading.findings.length === 0) return undefined;
  const open = openText ? readPostDeployPage(openText) : undefined;
  return {
    findings: reading.findings,
    sha: reading.sha,
    since: open?.since || reading.sha,
    deploys: (open?.deploys || 0) + 1,
    runUrl: reading.runUrl,
  };
}

/** What a 🧪 TEST RUN posts for this reading: the page it would post, or the resolution. Pure. */
export function postDeployTestText(reading: PostDeployReading) {
  const page = postDeployPage(reading, undefined);
  return page ? postDeployPageText(page, true) : resolvedText(passedWhy(reading), true);
}

/** One check's page in #error-pulse (keepPage): a failure posts the page or edits the open one; a
 *  pass resolves it. Returns the step taken. */
export function reportPostDeploy(slack: WebClient, reading: PostDeployReading) {
  return keepPage(slack, {
    marker: MARKER,
    sinceHours: 24,
    now: reading.now,
    render: async (openText) => {
      const page = postDeployPage(reading, openText);
      return page && postDeployPageText(page, false);
    },
    why: passedWhy(reading),
  });
}

/** A project host that answers 421 (no project is served there) or a 5xx is down; 0 is no answer. */
const hostIsDown = (status: number) => status === 421 || status >= 500 || status === 0;

/** The version `/version` names once it is not `previousVersion`, polled every 5 s for up to 60 s:
 *  the smokes in the deploy step only read status codes, so the runner's edge may still serve the
 *  old version (which answered fine in #2888). Past 60 s, whatever it named last. */
async function readNewVersion(previousVersion: string | undefined) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await get(VERSION_URL);
    const live = response?.status === 200 ? (await response.text()).split(" ")[0] : undefined;
    if ((live && live !== previousVersion) || Date.now() >= deadline) return live;
    await sleep(5_000);
  }
}

/** A page GET, the way a visitor reaches a project (a site render reads, never writes), tried again
 *  every 10 s while the host looks down, four tries in all: a blip while the rollout settles pages
 *  no one. */
async function readHost(url: string) {
  for (let attempt = 1; ; attempt++) {
    const status = (await get(url))?.status ?? 0;
    if (!hostIsDown(status) || attempt === 4) return { url, status };
    await sleep(10_000);
  }
}

/** null when nothing answered within 15 s. */
const get = (url: string) =>
  fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "iterate prd post-deploy check" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-post-deploy-check" }).run();

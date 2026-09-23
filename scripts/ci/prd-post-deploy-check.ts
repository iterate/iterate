// Prd post-deploy check (deploy-os-next.yml, the deploy job's step right after every prd deploy): wait
// (≤ 60 s) for `/version` to name a version other than the one live before the deploy, so the hosts
// are read on the new one, then one GET of each production project host, four tries 10 s apart while
// it looks down. A `/version` that never moves, or a host still answering 421 or 5xx or not at all,
// pages #error-pulse (top-level, mentioning Jonas) and fails the workflow. On 2026-09-23 #2888 moved
// the project catalog and its post-merge replay did not run: every project host answered 421 for ~20
// minutes while /version, the OAuth metadata smokes and the fault alarm (a 421 is no error) stayed
// green. Faults on the new version are the prd fault alarm's (scripts/ci/prd-fault-alarm.ts, every 15
// minutes). READ-ONLY: `/version` and page GETs — it never creates a project, a user or an account.
//
//   pnpm tsx scripts/ci/prd-post-deploy-check.ts check [--previous-version <id>] [--dry-run]
import { setTimeout as sleep } from "node:timers/promises";
import { createCli } from "trpc-cli";
import { osEnvs } from "../../envs.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

/** Production's project hosts, from envs.ts: each apex prd serves as a project's site
 *  (`osEnvs.prd.temporaryCustomHostnames` — iterate.com, garple.com, lispwoso.com, templestein.com). */
export const PRD_PROJECT_HOST_URLS = Object.keys(osEnvs.prd!.temporaryCustomHostnames || {}).map(
  (hostname) => `https://${hostname}/`,
);

/** `<version id> <origin>` (apps/os/src/worker.ts): the Cloudflare version prd serves. */
const VERSION_URL = `${osEnvs.prd!.baseUrl}/version`;

/** Waits for `/version` to name a version other than --previous-version (the id it named before the
 *  deploy; empty when it did not answer then), then GETs each production project host. */
export async function check(options: { previousVersion?: string; dryRun?: boolean } = {}) {
  const liveVersion = await readNewVersion(options.previousVersion);
  const hosts = await Promise.all(PRD_PROJECT_HOST_URLS.map(readHost));
  const page = renderPostDeployPage({
    previousVersion: options.previousVersion,
    liveVersion,
    hosts,
    runUrl: process.env.DEPOT_JOB_URL,
  });
  console.log(JSON.stringify({ previousVersion: options.previousVersion, liveVersion, hosts }));
  if (!page) return `os-next-prd version ${liveVersion} is live and every project host answers`;
  if (!options.dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: page,
    });
  throw new Error(`prd post-deploy check failed:\n${page}`);
}

/** The page for one post-deploy check, or null when `/version` names a new version and every
 *  project host answers: a line when `/version` still names the previous version (or did not
 *  answer), and a line per host that is down. Pure. */
export function renderPostDeployPage(input: {
  previousVersion?: string;
  /** What `/version` last named, undefined when it never answered 200. */
  liveVersion?: string;
  hosts: { url: string; status: number }[];
  runUrl?: string;
}): string | null {
  const versionLine = !input.liveVersion
    ? `• ${VERSION_URL} did not answer 200`
    : input.liveVersion === input.previousVersion &&
      `• ${VERSION_URL} still names \`${input.liveVersion.slice(0, 8)}\`, the version live before the deploy`;
  const down = input.hosts.filter((host) => hostIsDown(host.status));
  if (!versionLine && down.length === 0) return null;
  return [
    // the mention is Jonas (./slack.ts)
    `🚨 prd post-deploy check failed after the os-next-prd deploy <@U067G4QRFK2>`,
    versionLine,
    ...down.map((host) =>
      host.status
        ? `• the project host ${host.url} answered ${host.status}`
        : `• the project host ${host.url} did not answer`,
    ),
    input.runUrl && `<${input.runUrl}|the deploy run>`,
  ]
    .filter(Boolean)
    .join("\n");
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

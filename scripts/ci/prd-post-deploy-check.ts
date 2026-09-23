// Prd post-deploy check (deploy-os-next.yml `verify`, after every prd deploy): five minutes after the
// deploy, the prd fault alarm's own query (scripts/ci/prd-fault-alarm.ts `readWindow`) over the
// window since the deploy, on the NEW version's invocations only, at the alarm's own bar; and one GET
// of each production project host. Any fault, or a host answering 421 or 5xx, pages #error-pulse
// (top-level, mentioning Jonas) and fails the workflow. On 2026-09-23 #2888 moved the project
// catalog and its post-merge replay did not run: every project host answered 421 for ~20 minutes
// while /version, the OAuth metadata smokes and the fault alarm (a 421 is no error) stayed green.
// READ-ONLY: Workers Logs, `/version` and page GETs — it never creates a project, a user or an
// account, and writes nothing.
//
//   doppler run --project project-worker --config prd -- \
//     pnpm tsx scripts/ci/prd-post-deploy-check.ts check --deployed-at 2026-09-23T16:20:00Z [--dry-run]
import { createCli } from "trpc-cli";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { type FaultReading, readWindow, renderFaultPage } from "./prd-fault-alarm.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

/** Production's project hosts, from envs.ts: each apex prd serves as a project's site
 *  (`osEnvs.prd.temporaryCustomHostnames` — iterate.com, garple.com, lispwoso.com, templestein.com). */
export const PRD_PROJECT_HOST_URLS = Object.keys(osEnvs.prd!.temporaryCustomHostnames || {}).map(
  (hostname) => `https://${hostname}/`,
);

/** A project host that answers 421 (no project is served there) or a 5xx is down; 0 is no answer. */
const hostIsDown = (status: number) => status === 421 || status >= 500 || status === 0;

/** The page for one post-deploy check, or null when the new version is quiet and every project host
 *  answers: the fault alarm's page and bar, titled for the deploy, plus a line per host that is down.
 *  Pure. */
export function renderPostDeployPage(input: {
  reading: FaultReading;
  versionId: string;
  since: Date;
  until: Date;
  hosts: { url: string; status: number }[];
}): string | null {
  const time = (date: Date) => date.toISOString().slice(11, 16);
  return renderFaultPage(input.reading, input.until, {
    title: `🚨 prd post-deploy check: os-next-prd version \`${input.versionId.slice(0, 8)}\`, ${time(input.since)}–${time(input.until)} UTC <@U067G4QRFK2>`,
    extraLines: input.hosts
      .filter((host) => hostIsDown(host.status))
      .map((host) =>
        host.status
          ? `• the project host ${host.url} answered ${host.status}`
          : `• the project host ${host.url} did not answer`,
      ),
  });
}

export async function check(options: {
  deployedAt: string;
  settleMinutes?: number;
  dryRun?: boolean;
}) {
  const since = new Date(options.deployedAt);
  if (Number.isNaN(since.getTime()))
    throw new Error(`--deployed-at ${options.deployedAt} is no time`);
  const settleUntil = since.getTime() + (options.settleMinutes ?? 5) * 60_000;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, settleUntil - Date.now())));
  // `/version` answers `<version id> <origin>` (apps/os/src/worker.ts): the deploy that is live now.
  const version = await fetch(`${osEnvs.prd!.baseUrl}/version`);
  const versionId = z
    .string()
    .regex(/^[0-9a-f-]{36}$/)
    .parse((await version.text()).split(" ")[0]);
  const until = new Date();
  const reading = await readWindow(until, { from: since, scriptVersionId: versionId });
  // One page GET per host, the way a visitor reaches a project: a site render reads, never writes.
  const hosts = await Promise.all(
    PRD_PROJECT_HOST_URLS.map(async (url) => ({
      url,
      status: await fetch(url, {
        redirect: "manual",
        headers: { "user-agent": "iterate prd post-deploy check" },
        signal: AbortSignal.timeout(30_000),
      }).then(
        (response) => response.status,
        () => 0,
      ),
    })),
  );
  const page = renderPostDeployPage({ reading, versionId, since, until, hosts });
  console.log(JSON.stringify({ versionId, since, until, reading, hosts }));
  if (!page)
    return `os-next-prd version ${versionId} is quiet since the deploy, and every project host answers`;
  if (!options.dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: page,
    });
  throw new Error(`prd post-deploy check failed:\n${page}`);
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "prd-post-deploy-check" }).run();

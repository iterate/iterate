// Prd post-deploy check (deploy-os.yml, the deploy job's step right after every prd deploy): wait
// (≤ 60 s) for `/version` to name a version other than the one live before the deploy, so the hosts
// are read on the new one, then one GET of each production project host, four tries 10 s apart while
// it looks down. A `/version` that never moves, or a host still answering 421 or 5xx or not at all,
// pages #error-pulse (top-level, mentioning Jonas) and fails the workflow. On 2026-09-23 #2888 moved
// the project catalog and its post-merge replay did not run: every project host answered 421 for ~20
// minutes while /version, the OAuth metadata smokes and the fault alarm (a 421 is no error) stayed
// green. Faults on the new version are the prd fault alarm's (scripts/ci/prd-fault-alarm.ts, every 15
// minutes). When a host is down, the page also says what Workers Logs says: the down hosts' most
// frequent failure since ten minutes before the new version's upload, and whether that failure began
// BEFORE the upload. On 2026-09-24 every host was down after #3018's deploy, and the cause was a
// Cloudflare fault the deploy only landed in: the `CONTROL_PLANE` Durable Object had been failing
// `ControlPlane.getProject` since 53 s before the upload — one line, instead of an investigation.
// READ-ONLY: `/version`, page GETs, the version's metadata and Workers Logs — it never creates a
// project, a user or an account.
//
//   doppler run --project os --config prd -- \
//     pnpm tsx scripts/ci/prd-post-deploy-check.ts check [--previous-version <id>] [--dry-run]
import { setTimeout as sleep } from "node:timers/promises";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { osEnvs } from "../../envs.ts";
import { type CloudflareCredentials, queryWorkersLogs } from "./prd-fault-alarm.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";

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
export async function check(options: { previousVersion?: string; dryRun?: boolean } = {}) {
  const liveVersion = await readNewVersion(options.previousVersion);
  const hosts = await Promise.all(PRD_PROJECT_HOST_URLS.map(readHost));
  const down = hosts.filter((host) => hostIsDown(host.status)).map((host) => host.url);
  const { CLOUDFLARE_ACCOUNT_ID: accountId = "", CLOUDFLARE_API_TOKEN: apiToken = "" } =
    process.env;
  // the cause is extra: a read that fails says so on the page and never loses it
  const cause = down.length
    ? await readFailureCause({
        cloudflare: { accountId, apiToken },
        hosts: down,
        newVersion: liveVersion === options.previousVersion ? undefined : liveVersion,
        now: Date.now(),
      }).catch((error: unknown) => ({
        unread: error instanceof Error ? error.message : String(error),
      }))
    : undefined;
  const page = renderPostDeployPage({
    previousVersion: options.previousVersion,
    liveVersion,
    hosts,
    cause,
    runUrl: process.env.DEPOT_JOB_URL,
  });
  console.log(
    JSON.stringify({ previousVersion: options.previousVersion, liveVersion, hosts, cause }),
  );
  if (!page)
    return `${osEnvs.prd!.workerName} version ${liveVersion} is live and every project host answers`;
  if (!options.dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: page,
    });
  throw new Error(`prd post-deploy check failed:\n${page}`);
}

/** The page for one post-deploy check, or null when `/version` names a new version and every
 *  project host answers: a line when `/version` still names the previous version (or did not
 *  answer), a line per host that is down, and what Workers Logs says caused it. Pure. */
export function renderPostDeployPage(input: {
  previousVersion?: string;
  /** What `/version` last named, undefined when it never answered 200. */
  liveVersion?: string;
  hosts: { url: string; status: number }[];
  /** readFailureCause's answer, when a host is down. */
  cause?: FailureCause;
  runUrl?: string;
}): string | null {
  const versionLine = !input.liveVersion
    ? `• ${VERSION_URL} did not answer 200`
    : input.liveVersion === input.previousVersion &&
      `• ${VERSION_URL} still names \`${input.liveVersion.slice(0, 8)}\`, the version live before the deploy`;
  const down = input.hosts.filter((host) => hostIsDown(host.status));
  if (!versionLine && down.length === 0) return null;
  return [
    `🚨 prd post-deploy check failed after the ${osEnvs.prd!.workerName} deploy ${onCallMention}`,
    versionLine,
    ...down.map((host) =>
      host.status
        ? `• the project host ${host.url} answered ${host.status}`
        : `• the project host ${host.url} did not answer`,
    ),
    input.cause && causeLine(input.cause),
    input.runUrl && `<${input.runUrl}|the deploy run>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A project host that answers 421 (no project is served there) or a 5xx is down; 0 is no answer. */
const hostIsDown = (status: number) => status === 421 || status >= 500 || status === 0;

/** What Workers Logs says about the down hosts (readFailureCause), or why it could not be read. */
export type FailureCause =
  | { unread: string }
  | {
      /** where the read starts: ten minutes before the upload (before the check, with none) */
      since: number;
      /** the new version's upload (its Cloudflare metadata `created_on`); none when `/version`
       *  never named a new version */
      uploadedAt?: number;
      /** the down hosts' most frequent failure since `since`, and how many failures they logged
       *  in all (the newest 100 read) — none: nothing logged */
      dominant?: { signature: string; count: number; of: number };
      /** that failure anywhere in os-prd before the upload: how often (in the newest 100 read), and
       *  the earliest of those */
      before?: { count: number; first: number };
    };

/** The page's line for `cause`. */
function causeLine(cause: FailureCause) {
  if ("unread" in cause) return `• Workers Logs could not say why: ${cause.unread}`;
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const atLeast = (count: number) => (count >= 100 ? `${count}+` : String(count));
  if (!cause.dominant)
    return `• Workers Logs holds no error or platform-failure warn on these hosts since ${clock(cause.since)} UTC`;
  const { signature, count, of } = cause.dominant;
  const most = `• Workers Logs: ${count} of these hosts' ${atLeast(of)} failures since ${clock(cause.since)} UTC are \`${signature}\``;
  if (!cause.uploadedAt) return most;
  const upload = `the new version's upload (${clock(cause.uploadedAt)} UTC)`;
  if (!cause.before) return `${most}; none of it came before ${upload}`;
  const { count: earlier, first } = cause.before;
  const lead = `${Math.round((cause.uploadedAt - first) / 1000)} s earlier`;
  // past the newest 100 read, the earliest read is only a bound on when it began
  if (earlier >= 100)
    return `${most}; it began BEFORE ${upload}: by ${clock(first)} at the latest, ${lead}, ${atLeast(earlier)} times before the upload`;
  return `${most}; it began BEFORE ${upload}: first at ${clock(first)}, ${lead}, ${earlier} times before the upload`;
}

/** A failure on a request, as the post-deploy page names it: a platform-failure warn by its
 *  `event`, an exception by its message (a reference collapsed, as the fault alarm's page does) and
 *  its first two stack frames — `internal error; reference = …` alone could be anything. */
const LoggedFailure = z.object({
  timestamp: z.number(),
  source: z
    .object({
      event: z.string().optional(),
      exception: z.object({ stack: z.string().optional() }).optional(),
    })
    .optional()
    .catch(undefined),
  $metadata: z.object({ message: z.string().nullish(), error: z.string().nullish() }),
});
const signatureOf = (failure: z.infer<typeof LoggedFailure>) => {
  if (failure.source?.event?.includes("platform-failure")) return failure.source.event;
  const message = (failure.$metadata.message || failure.$metadata.error || "").replace(
    /reference = \w+/g,
    "reference = …",
  );
  const frames = framesOf(failure).join(" < ");
  return frames ? `${message} at ${frames}` : message;
};
/** An exception's first two stack frames, by name. */
const framesOf = (failure: z.infer<typeof LoggedFailure>) =>
  [...(failure.source?.exception?.stack ?? "").matchAll(/at (?:async )?([^\s(]+)/g)]
    .slice(0, 2)
    .map((match) => match[1]!);

/** An exception (not the invocation's own summary line) or a platform-failure warn. */
const FAILURE_FILTER = {
  kind: "group",
  filterCombination: "or",
  filters: [
    {
      kind: "group",
      filterCombination: "and",
      filters: [
        { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
        { key: "$metadata.type", operation: "neq", value: "cf-worker-event", type: "string" },
      ],
    },
    { key: "event", operation: "includes", value: "platform-failure", type: "string" },
  ],
};

/** Workers Logs on the down `hosts`, from ten minutes before the new version's upload: their most
 *  frequent failure, then the same failure anywhere in os-prd before the upload. At most three
 *  bounded reads (the version's metadata, two queries of the newest 100 events, 30 s each). */
export async function readFailureCause(input: {
  cloudflare: CloudflareCredentials;
  hosts: string[];
  /** the version `/version` named after the deploy; undefined when it never moved */
  newVersion?: string;
  now: number;
}): Promise<FailureCause> {
  const { cloudflare } = input;
  if (!cloudflare.accountId || !cloudflare.apiToken)
    throw new Error("no Cloudflare credentials: run under doppler --project os --config prd");
  const uploadedAt = input.newVersion
    ? await readUploadedAt(cloudflare, input.newVersion)
    : undefined;
  const since = (uploadedAt ?? input.now) - 10 * 60_000;
  const failures = async (from: number, to: number, filters: object[]) =>
    z.object({ events: z.object({ events: z.array(LoggedFailure) }) }).parse(
      await queryWorkersLogs(cloudflare, {
        view: "events",
        services: [osEnvs.prd!.workerName],
        from,
        to,
        filters,
      }),
    ).events.events;
  const hostnames = input.hosts.map((url) => new URL(url).hostname.replaceAll(".", "\\."));
  const onHosts = await failures(since, input.now, [
    {
      key: "$workers.event.request.url",
      operation: "regex",
      value: `^https?://(${hostnames.join("|")})([/?]|$)`,
      type: "string",
    },
    FAILURE_FILTER,
  ]);
  const counts = new Map<string, number>();
  for (const failure of onHosts)
    counts.set(signatureOf(failure), (counts.get(signatureOf(failure)) ?? 0) + 1);
  const [dominant] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!dominant) return { since, uploadedAt };
  const [signature, count] = dominant;
  if (!uploadedAt) return { since, dominant: { signature, count, of: onHosts.length } };
  // the same failure anywhere before the upload: its event, or its text in the field it came from
  // and its frames on the stack (`internal error;` alone is every opaque error in os-prd), so the
  // newest 100 read are this failure's; then its whole signature here
  const sample = onHosts.find((failure) => signatureOf(failure) === signature)!;
  const includes = (key: string, value: string) => ({
    key,
    operation: "includes",
    value,
    type: "string",
  });
  const earlier = (
    await failures(since, uploadedAt, [
      ...(sample.source?.event?.includes("platform-failure")
        ? [{ key: "event", operation: "eq", value: sample.source.event, type: "string" }]
        : [
            sample.$metadata.message
              ? includes("$metadata.message", sample.$metadata.message.split(" reference = ")[0]!)
              : includes(
                  "$metadata.error",
                  (sample.$metadata.error || "").split(" reference = ")[0]!,
                ),
            ...framesOf(sample).map((frame) => includes("exception.stack", frame)),
          ]),
      FAILURE_FILTER,
    ])
  ).filter((failure) => signatureOf(failure) === signature);
  return {
    since,
    uploadedAt,
    dominant: { signature, count, of: onHosts.length },
    before: earlier.length
      ? { count: earlier.length, first: Math.min(...earlier.map((failure) => failure.timestamp)) }
      : undefined,
  };
}

/** When `version` was uploaded: Cloudflare's version metadata (`created_on`). */
async function readUploadedAt({ accountId, apiToken }: CloudflareCredentials, version: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${osEnvs.prd!.workerName}/versions/${version}`,
    { headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30_000) },
  );
  const body = z
    .object({ result: z.object({ metadata: z.object({ created_on: z.string() }) }) })
    .parse(await response.json());
  return Date.parse(body.result.metadata.created_on);
}

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

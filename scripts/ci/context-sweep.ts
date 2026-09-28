// THE CONTEXT SWEEP — what Cloudflare stores against what the platform holds. A project's deletion
// (apps/os/src/project/processor.ts) destroys the contexts its registry names; a context whose
// announcement never landed is not named, so it would outlive its project, stored and billed, with
// no way to find it by name. Cloudflare lists every object of the context namespace that holds data
// (the List Objects API, by id alone); each says who it is from its own birth record
// (`session.contexts.identify`, which records no wake), and one whose project the control plane
// does not hold (deleted, or never created: an operator's made-up `prj_…`) is an orphan.
//
// Report-only unless `--destroy`, which backs each orphan up and then destroys it. The backup is one
// JSON Lines object in the CI bucket (envs.ts `ciBucketEnvs`, docs/test-evidence.md#one-bucket),
// `backups/context-sweep/<env>/<run's start, UTC>/<context id>.jsonl`: its first line the context's
// identity `{ id, projectId, path }`, then its whole durable log, one event a line in offset order,
// as `session.contexts.readEvents` pages it (without a wake) up to the head. The destruction
// (`session.contexts.destroy`, refused for a global context and for any project that still exists)
// waits for the bucket to hold the backup: an orphan whose backup did not land is left for the next
// run. A backup holds the log alone: a context's kv and its facets' storage go with it.
//
//   pnpm tsx scripts/ci/context-sweep.ts --env prd [--destroy]
//
// The deployment's Cloudflare credentials and APP_CONFIG (its operator bearer) come from its own
// Doppler config (scripts/lib/env-context.ts `resolveEnvContext`, which refuses a Doppler account
// that is not envs.ts's); `--destroy` writes the CI bucket with CLOUDFLARE_API_TOKEN from the
// environment (Doppler `_shared/preview`'s, as the test evidence upload does). It fails when an
// object could not say who it is or an orphan was not destroyed; orphans alone are the report, not
// a failure. The report is the step's `report` output too (GITHUB_OUTPUT), which `post` sends to
// Slack.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { IterateSessionApi } from "iterate/api";
import { connectIterate } from "iterate/node";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { OS_DOPPLER_PROJECT, ciBucketEnvs, osEnvs } from "../../envs.ts";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { getWorkerDoNamespaces } from "../lib/do-reset.ts";
import { resolveEnvContext } from "../lib/env-context.ts";
import { ciBucket } from "./ci-bucket.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";

/** One stored object as the sweep sees it. */
export type SweptContext = Awaited<ReturnType<IterateSessionApi["contexts"]["identify"]>>[number];

/** What an object with no birth record answers (apps/os iterate-context-durable-object.ts
 *  `iterateContextAddressOf`): it is empty — destroyed moments ago, and Cloudflare's list still
 *  flags it as holding data for a few minutes (measured on prd, 2026-09-25: up to ~7 min). */
const EMPTIED = "only a context that was born answers";

/** What the sweep does with each object: a live project's context, a global context (users,
 *  organizations: never swept), an orphan of a project the control plane does not hold, one just
 *  emptied (destroyed, the list not caught up), or one that could not say who it is. */
export function classifyContexts(contexts: SweptContext[], liveProjectIds: ReadonlySet<string>) {
  const report = {
    live: [] as string[],
    global: [] as string[],
    orphans: [] as { id: string; projectId: string; path: string }[],
    emptied: [] as string[],
    unidentified: [] as { id: string; error: string }[],
  };
  for (const context of contexts) {
    if ("error" in context && context.error.includes(EMPTIED)) report.emptied.push(context.id);
    else if ("error" in context) report.unidentified.push(context);
    else if (context.projectId === "global") report.global.push(context.id);
    else if (liveProjectIds.has(context.projectId)) report.live.push(context.id);
    else report.orphans.push(context);
  }
  return report;
}

/** The largest page Cloudflare's List Objects API answers. The API client hands back no cursor, so
 *  the sweep reads one page and refuses a full one, which may be cut off. */
const OBJECTS_PAGE = 10_000;

/** Sweep the context namespace of the OS deployment `env`: report every orphan, and with `destroy`
 *  back each one up and destroy it. */
export default async function contextSweep(options: {
  /** The OS deployment to sweep (envs.ts osEnvs). */
  env: string;
  /** Back up and destroy each orphan (session.contexts.readEvents, then destroy). */
  destroy?: boolean;
}) {
  // Before anything is read: a backup that cannot be written would leave every orphan standing.
  const putBackup = options.destroy ? await backupWriter() : null;
  const ctx = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const target = ctx.env;
  const namespaces = (await getWorkerDoNamespaces(ctx, target.workerName)).filter(
    ({ className }) => className === "IterateContextDurableObject",
  );
  if (namespaces.length !== 1)
    throw new Error(
      `expected one IterateContextDurableObject namespace on ${target.workerName}, found ${namespaces.length}`,
    );
  const { namespaceId } = namespaces[0]!;
  const objects = await ctx.cf<{ id: string; hasStoredData?: boolean }[]>(
    `/workers/durable_objects/namespaces/${namespaceId}/objects?limit=${OBJECTS_PAGE}`,
  );
  if (objects.length >= OBJECTS_PAGE)
    throw new Error(`${OBJECTS_PAGE} or more context objects: the listing may be cut off`);
  const stored = objects.filter((row) => row.hasStoredData).map((row) => row.id);

  const config = parseAppConfig({
    APP_CONFIG: ctx.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: ctx.secrets.APP_CONFIG_SECRETS__KEY,
  });
  using connection = await connectIterate({
    baseUrl: target.baseUrl,
    auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
  });
  const { session } = connection;
  const contexts: SweptContext[] = [];
  for (let start = 0; start < stored.length; start += 50)
    contexts.push(...(await session.contexts.identify(stored.slice(start, start + 50))));
  const live = new Set((await session.projects.list()).map((project) => project.id));
  const classified = classifyContexts(contexts, live);

  const backupPrefix = `backups/context-sweep/${options.env}/${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}/`;
  const swept = putBackup
    ? await backUpAndDestroy({
        orphans: classified.orphans,
        contexts: session.contexts,
        putBackup,
        prefix: backupPrefix,
      })
    : { destroyed: [], failed: [] };

  const report: ContextSweepReport = {
    env: options.env,
    stored: stored.length,
    live: classified.live.length,
    global: classified.global.length,
    orphans: classified.orphans.length,
    emptied: classified.emptied.length,
    unidentified: classified.unidentified.length,
    destroyed: swept.destroyed.length,
    destroyFailed: swept.failed.length,
    backups: putBackup ? `r2://${ciBucketEnvs.ci.bucketName}/${backupPrefix}` : undefined,
  };
  console.log(JSON.stringify({ event: "context-sweep.report", namespace: namespaceId, ...report }));
  for (const orphan of classified.orphans)
    console.log(`orphan ${orphan.projectId}${orphan.path} (${orphan.id})`);
  for (const context of classified.unidentified)
    console.log(`unidentified ${context.id}: ${context.error}`);
  for (const failure of swept.failed) console.log(`not destroyed ${failure.id}: ${failure.error}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
  if (report.unidentified || report.destroyFailed)
    throw new Error(
      `${report.unidentified} object(s) could not say who they are, ${report.destroyFailed} orphan(s) not destroyed`,
    );
}

/** Posts a sweep job's result (context-sweep.yml's notify job): to #ci always, and to #error-pulse
 *  when it destroyed anything or failed. REPORT is the sweep job's `report` output (empty when it
 *  failed before its report), RESULT its result; the link is the notify job's own Depot page. */
export async function post() {
  const slack = getSlackClient();
  for (const message of sweepMessages({
    report: process.env.REPORT
      ? ContextSweepReport.parse(JSON.parse(process.env.REPORT))
      : undefined,
    result: required("RESULT"),
    refName: required("GITHUB_REF_NAME"),
    runUrl: required("DEPOT_JOB_URL"),
  }))
    await slack.chat.postMessage(message);
}

/** What one sweep found and did: counts of the objects Cloudflare lists as holding data, by what
 *  each is, and of the orphans destroyed (each backed up first, under `backups`) and not. */
const ContextSweepReport = z.object({
  env: z.string(),
  stored: z.number(),
  live: z.number(),
  global: z.number(),
  orphans: z.number(),
  emptied: z.number(),
  unidentified: z.number(),
  destroyed: z.number(),
  destroyFailed: z.number(),
  backups: z.string().optional(),
});
type ContextSweepReport = z.infer<typeof ContextSweepReport>;

/** Each orphan in turn: its backup, `<prefix><id>.jsonl` (the header says what it holds), then its
 *  destruction once `putBackup` resolves. An orphan whose backup or destruction failed is named in
 *  `failed`, and the sweep goes on to the next. */
export async function backUpAndDestroy(input: {
  orphans: { id: string; projectId: string; path: string }[];
  contexts: Pick<IterateSessionApi["contexts"], "readEvents" | "destroy">;
  /** Resolves once the CI bucket holds `body` at `key`. */
  putBackup: (key: string, body: Uint8Array) => Promise<void>;
  prefix: string;
}) {
  const destroyed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const { id, projectId, path } of input.orphans)
    try {
      // a page's lines at a time: one string of a whole log could pass V8's string limit (~512 MiB)
      const chunks = [Buffer.from(`${JSON.stringify({ id, projectId, path })}\n`)];
      for (let afterOffset = 0; ;) {
        const page = await input.contexts.readEvents(id, afterOffset);
        chunks.push(Buffer.from(page.events.map((event) => `${JSON.stringify(event)}\n`).join("")));
        if (page.atHead) break;
        afterOffset = page.scannedThroughOffset;
      }
      await input.putBackup(`${input.prefix}${id}.jsonl`, Buffer.concat(chunks));
      await input.contexts.destroy(id);
      destroyed.push(id);
    } catch (error) {
      failed.push({ id, error: String(error).slice(0, 300) });
    }
  return { destroyed, failed };
}

/** A sweep's Slack posts: its result to #ci, and the same to #error-pulse, mentioning Jonas and
 *  Misha, when it destroyed anything or did not succeed. Pure. */
export function sweepMessages(input: {
  report: ContextSweepReport | undefined;
  /** The sweep job's result: `success`, `failure`, `cancelled`. */
  result: string;
  refName: string;
  runUrl: string;
}) {
  const { report } = input;
  const failed = input.result !== "success";
  const summary = report
    ? [
        `${report.stored} stored, ${report.live} live, ${report.global} global, ${report.orphans} orphans`,
        report.emptied && `${report.emptied} just emptied`,
        report.unidentified && `${report.unidentified} could not say who they are`,
        report.destroyed &&
          `${report.destroyed} orphans destroyed, each backed up first to ${report.backups}`,
        report.destroyFailed && `${report.destroyFailed} orphans not destroyed`,
      ]
        .filter(Boolean)
        .join("; ")
    : "it failed before its report";
  const text = `${failed ? "🚨" : "🧹"} Context sweep${report ? ` of ${report.env}` : ""} on ${input.refName}${failed ? ` (${input.result})` : ""}: ${summary}`;
  const link = `<${input.runUrl}|View the Depot job>`;
  return [
    { channel: slackChannelIds["#ci"], text: `${text}\n${link}` },
    ...(failed || report?.destroyed
      ? [{ channel: slackChannelIds["#error-pulse"], text: `${text} ${onCallMention}\n${link}` }]
      : []),
  ];
}

/** Writes a backup into the CI bucket (scripts/ci/ci-bucket.ts, with the environment's
 *  CLOUDFLARE_API_TOKEN): a write-once PUT whose sha256 R2 checks. The run's keys are new, so a 412
 *  is this PUT's own earlier try, landed, when the key holds these very bytes (a single PUT's ETag
 *  is their MD5); anything else fails the backup. */
async function backupWriter() {
  const bucket = await ciBucket({
    accountId: ciBucketEnvs.ci.cloudflareAccountId,
    bucketName: ciBucketEnvs.ci.bucketName,
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    area: "context-sweep",
    // a large context's backup is a few hundred megabytes: minutes on a slow link
    timeoutMs: 600_000,
  });
  return async (key: string, body: Uint8Array) => {
    const response = await bucket.put(key, body, {
      contentType: "application/x-ndjson",
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    if (response.ok) return;
    const answer = `${response.status} ${await response.text()}`;
    if (response.status === 412) {
      // Cloudflare's edge may mark the ETag weak: `W/"<md5>"`.
      const etag = (await bucket.head(key)).headers
        .get("etag")
        ?.match(/^(?:W\/)?"([0-9a-f]{32})"$/u)?.[1];
      if (etag === createHash("md5").update(body).digest("hex")) return;
    }
    throw new Error(`R2 PUT ${ciBucketEnvs.ci.bucketName}/${key}: ${answer}`);
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see scripts/ci/context-sweep.ts)`);
  return value;
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "context-sweep" }).run();

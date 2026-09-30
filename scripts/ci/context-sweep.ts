// THE CONTEXT SWEEP — what Cloudflare stores against what the platform holds. A project's deletion
// (apps/os/src/project/processor.ts) destroys the contexts its registry names; a context whose
// announcement never landed is not named, so it would outlive its project, stored and billed, with
// no way to find it by name. Cloudflare lists every object of the context namespace that holds data
// (the List Objects API, by id alone); each says who it is from its own birth record
// (`session.contexts.identify`, which records no wake), and one whose project the control plane
// does not hold (deleted, or never created: an operator's made-up `prj_…`) is an orphan.
//
// Report-only unless `--destroy`, which backs each orphan up and then destroys it. The backup is one
// JSON Lines object in the deployment's backup bucket (envs.ts `backupBucketEnvs`: prd's alone,
// `iterate-prd-backups` on the prd account), `context-sweep/<run's start, UTC>/<context id>.jsonl`:
// its first line the context's identity `{ id, projectId, path }`, then its whole durable log, one
// event a line in offset order, as `session.contexts.readEvents` pages it (without a wake) up to the
// head. The destruction (`session.contexts.destroy`, refused for a global context and for any
// project that still exists) waits for the bucket to hold the backup: an orphan whose backup did not
// land is left for the next run, and so is one whose newest event is under an hour old (a running
// test's context, whose project was made up: the nightly crash hunt's). A backup holds the log
// alone: a context's kv and its facets' storage go with it. Each object's identification and each
// orphan's read and destruction is asked again when the platform failed it (`retryPlatformFailures`,
// CI_HTTP): a prd deploy mid-sweep resets every context and may drop the session's socket, which is
// connected again (`identifyEach`, `backUpAndDestroy`). Each orphan logs one
// `context-sweep.orphan` line as soon as it is done, so a run cut short still says what it destroyed.
//
//   node scripts/ci/context-sweep.ts --env prd [--destroy]
//
// The deployment's Cloudflare credentials and APP_CONFIG (its operator bearer) come from its own
// Doppler config (scripts/lib/env-context.ts `resolveEnvContext`, which refuses a Doppler account
// that is not envs.ts's); `--destroy` writes the backup bucket with that same Cloudflare API token,
// so prd's event logs are written and read with prd's credentials alone, and is refused for a
// deployment without a backup bucket. It fails when an object could not say who it is or an orphan
// was not destroyed; orphans alone are the report, not a failure. The report is the step's `report` output too (GITHUB_OUTPUT), which `post` sends to
// Slack.
//
// The backup bucket was made with Doppler `_shared/prd`'s token (the one os/prd inherits), every
// object expiring 365 days after it lands:
//
//   doppler run --project _shared --config prd -- pnpm --dir apps/os exec wrangler r2 bucket create iterate-prd-backups
//   doppler run --project _shared --config prd -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-prd-backups backups-after-365-days --expire-days 365 --force
import { appendFileSync } from "node:fs";
import type { IterateSessionApi } from "iterate/api";
import { connectIterate, type IterateConnection } from "iterate/node";
import { createCli } from "trpc-cli";
import { z } from "zod";
import {
  CI_HTTP,
  failureKind,
  isPlatformFailureKind,
  retryPlatformFailures,
  type FailureKind,
} from "iterate/platform-retry";
import { OS_DOPPLER_PROJECT, backupBucketEnvs, getEnv, osEnvs } from "../../envs.ts";
import type { OsDeployableEnv } from "../../apps/os/scripts/os-env.ts";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { getWorkerDoNamespaces } from "../lib/do-reset.ts";
import { resolveEnvContext, type EnvContext } from "../lib/env-context.ts";
import { ciBucket } from "./ci-bucket.ts";
import { getSlackClient, keepPage, pageText, slackChannelIds } from "./slack.ts";

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

/** Who each of `ids` is (`identify`, 50 at a time), each batch asked again while the platform fails
 *  it (a session whose socket a deploy closed). An object whose answer is a platform failure, a
 *  deploy's reset of that context above all, is asked again on its own on CI_HTTP's waits, as a read
 *  or a destruction is: `identify` records no wake, so it is safe to repeat. The answer it gets once
 *  the waits run out is kept, and the sweep fails on it as unidentified. */
export async function identifyEach(
  ids: string[],
  identify: (ids: string[]) => Promise<SweptContext[]>,
) {
  const contexts: SweptContext[] = [];
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    const answers = await retryingPlatformFailures(
      `identify ${batch.length} from ${batch[0]}`,
      () => identify(batch),
    );
    for (const answer of answers)
      contexts.push(platformFailed(answer) ? await identifyAgain(answer.id, identify) : answer);
  }
  return contexts;
}

/** Whether an object's answer is a failure of the platform's, not of who it is (failureKind reads
 *  the error the session hands back as text). */
function platformFailed(answer: SweptContext): answer is { id: string; error: string } {
  return "error" in answer && isPlatformFailureKind(failureKind(new Error(answer.error)));
}

async function identifyAgain(
  id: string,
  identify: (ids: string[]) => Promise<SweptContext[]>,
): Promise<SweptContext> {
  const asked: { last?: SweptContext } = {};
  try {
    return await retryingPlatformFailures(`identify ${id}`, async () => {
      const [answer = { id, error: "identify answered nothing" }] = await identify([id]);
      asked.last = answer;
      if (platformFailed(answer)) throw new Error(answer.error);
      return answer;
    });
  } catch (error) {
    // the waits ran out: the last answer, or why the last ask got none
    return asked.last || { id, error: String(error).slice(0, 300) };
  }
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
  const ctx = await resolveEnvContext(getEnv(options.env, osEnvs), {
    dopplerProject: OS_DOPPLER_PROJECT,
  });
  // Before anything is read: a backup that cannot be written would leave every orphan standing.
  const backups = options.destroy ? await backupWriter(ctx) : null;
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
  using connection = await reconnecting(() =>
    connectIterate({
      baseUrl: target.baseUrl,
      auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
    }),
  );
  const contexts = await identifyEach(stored, async (ids) =>
    (await connection.session()).contexts.identify(ids),
  );
  const live = new Set(
    (await (await connection.session()).projects.list()).map((project) => project.id),
  );
  const classified = classifyContexts(contexts, live);

  const backupPrefix = `context-sweep/${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}/`;
  const swept = backups
    ? await backUpAndDestroy({
        orphans: classified.orphans,
        contexts: {
          readEvents: async (id, afterOffset) =>
            (await connection.session()).contexts.readEvents(id, afterOffset),
          destroy: async (id) => (await connection.session()).contexts.destroy(id),
        },
        putBackup: backups.put,
        prefix: backupPrefix,
      })
    : { destroyed: [], recent: [], failed: [] };

  const report: ContextSweepReport = {
    env: options.env,
    stored: stored.length,
    live: classified.live.length,
    global: classified.global.length,
    orphans: classified.orphans.length,
    emptied: classified.emptied.length,
    unidentified: classified.unidentified.length,
    destroyed: swept.destroyed.length,
    recent: swept.recent.length,
    destroyFailed: swept.failed.length,
    backups: backups ? `r2://${backups.bucketName}/${backupPrefix}` : undefined,
  };
  console.log(JSON.stringify({ event: "context-sweep.report", namespace: namespaceId, ...report }));
  for (const orphan of classified.orphans)
    console.log(`orphan ${orphan.projectId}${orphan.path} (${orphan.id})`);
  for (const context of classified.unidentified)
    console.log(`unidentified ${context.id}: ${context.error}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
  if (report.unidentified || report.destroyFailed)
    throw new Error(
      `${report.unidentified} object(s) could not say who they are, ${report.destroyFailed} orphan(s) not destroyed`,
    );
}

/** Posts a sweep job's result (context-sweep.yml's notify job; see sweepPosts): the line to #ci,
 *  and the one #error-pulse page kept for a failing sweep (slack.ts `keepPage`), which the next run
 *  that succeeds resolves. REPORT is the sweep job's `report` output (empty when it failed before
 *  its report), RESULT its result; the link is the notify job's own Depot page. Only a run on main
 *  posts; one on another ref prints. A 🧪 test run posts its line, and its page if it failed, to #ci
 *  alone. */
export async function post(options: {
  /** post to #ci as a 🧪 TEST RUN, mentioning nobody; #error-pulse is never read */
  testRun?: boolean;
}) {
  const testRun = Boolean(options.testRun);
  const posts = sweepPosts({
    report: process.env.REPORT
      ? ContextSweepReport.parse(JSON.parse(process.env.REPORT))
      : undefined,
    result: required("RESULT"),
    runUrl: required("DEPOT_JOB_URL"),
    testRun,
  });
  console.log([posts.result, posts.page].filter(Boolean).join("\n\n"));
  if (!testRun && process.env.GITHUB_REF !== "refs/heads/main")
    return console.log("not a run on main: nothing posted");
  const slack = getSlackClient();
  await slack.chat.postMessage({ channel: slackChannelIds["#ci"], text: posts.result });
  if (testRun) {
    if (posts.page)
      await slack.chat.postMessage({ channel: slackChannelIds["#ci"], text: posts.page });
    return;
  }
  const step = await keepPage(slack, {
    marker: SWEEP_PAGE_MARKER,
    sinceHours: 30 * 24,
    now: new Date(),
    render: async () => posts.page,
    why: "the context sweep succeeded",
  });
  console.log(`#error-pulse page: ${step}`);
}

/** What one sweep found and did: counts of the objects Cloudflare lists as holding data, by what
 *  each is, and of the orphans destroyed (each backed up first, under `backups`), left for the next
 *  run as recent, and not destroyed. */
const ContextSweepReport = z.object({
  env: z.string(),
  stored: z.number(),
  live: z.number(),
  global: z.number(),
  orphans: z.number(),
  emptied: z.number(),
  unidentified: z.number(),
  destroyed: z.number(),
  recent: z.number(),
  destroyFailed: z.number(),
  backups: z.string().optional(),
});
type ContextSweepReport = z.infer<typeof ContextSweepReport>;

/** How recent an orphan's newest event may be for the sweep to destroy it: a context written in the
 *  last hour may belong to a test still running against a made-up project (the crash hunt's). */
const RECENT_MS = 60 * 60_000;

/** Each orphan in turn: its whole log, then — unless its newest event is recent — its backup,
 *  `<prefix><id>.jsonl` (the header says what it holds), and its destruction once `putBackup`
 *  resolves. Each read and destruction is asked again when the platform failed it; a destruction
 *  answered by an empty object (an earlier try that landed) is done. An orphan whose backup or
 *  destruction failed is named in `failed`, and the sweep goes on to the next. Each orphan logs
 *  one `context-sweep.orphan` line when it is done. */
export async function backUpAndDestroy(input: {
  orphans: { id: string; projectId: string; path: string }[];
  contexts: Pick<IterateSessionApi["contexts"], "readEvents" | "destroy">;
  /** Resolves once the backup bucket holds `body` at `key`. */
  putBackup: (key: string, body: Uint8Array) => Promise<void>;
  prefix: string;
  now?: () => number;
}) {
  const now = input.now || Date.now;
  const destroyed: string[] = [];
  const recent: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const { id, projectId, path } of input.orphans) {
    const key = `${input.prefix}${id}.jsonl`;
    const line = { event: "context-sweep.orphan", id, projectId, path };
    try {
      // a page's lines at a time: one string of a whole log could pass V8's string limit (~512 MiB)
      const chunks = [Buffer.from(`${JSON.stringify({ id, projectId, path })}\n`)];
      let events = 0;
      let newest = "";
      for (let afterOffset = 0; ;) {
        const page = await retryingPlatformFailures(`readEvents ${id}`, () =>
          input.contexts.readEvents(id, afterOffset),
        );
        chunks.push(Buffer.from(page.events.map((event) => `${JSON.stringify(event)}\n`).join("")));
        events += page.events.length;
        newest = page.events.at(-1)?.createdAt || newest;
        if (page.atHead) break;
        afterOffset = page.scannedThroughOffset;
      }
      if (newest && now() - Date.parse(newest) < RECENT_MS) {
        recent.push(id);
        console.log(JSON.stringify({ ...line, outcome: "recent", events, newest }));
        continue;
      }
      const body = Buffer.concat(chunks);
      await input.putBackup(key, body);
      await retryingPlatformFailures(`destroy ${id}`, () =>
        input.contexts.destroy(id).catch((error: unknown) => {
          if (!String(error).includes(EMPTIED)) throw error;
        }),
      );
      destroyed.push(id);
      console.log(
        JSON.stringify({ ...line, outcome: "destroyed", backup: key, bytes: body.length, events }),
      );
    } catch (error) {
      failed.push({ id, error: String(error).slice(0, 300) });
      console.log(JSON.stringify({ ...line, outcome: "not-destroyed", error: String(error) }));
    }
  }
  return { destroyed, recent, failed };
}

/** `call`, asked again on CI_HTTP's waits while the platform fails it: a deploy's reset of the
 *  context, or a session whose socket closed (capnweb's "Peer closed WebSocket", which
 *  `reconnecting` answers with a new connection) or could not be connected again. Every call is
 *  safe to repeat: an identification and a read record no wake, and a destruction whose landed try
 *  answers EMPTIED. */
const retryingPlatformFailures = <T>(name: string, call: () => Promise<T>) =>
  retryPlatformFailures(call, {
    area: "context-sweep",
    schedule: CI_HTTP,
    idempotent: true,
    kind: (error): FailureKind =>
      /Peer closed WebSocket/.test(String(error)) || String(error).includes(RECONNECT_FAILED)
        ? "disconnected"
        : failureKind(error),
    describe: () => ({ name }),
  });

/** The deployment's session, connected again once its socket closed: a prd deploy mid-sweep may
 *  close it. A connection that could not be made again (the deployment still restarting) fails as
 *  RECONNECT_FAILED, a platform failure the next repeat asks again. */
export async function reconnecting(connect: () => Promise<IterateConnection>) {
  let connection: IterateConnection | undefined = await connect();
  const watch = (current: IterateConnection) =>
    void current.closed.then(() => {
      if (current !== connection) return;
      connection = undefined;
      current[Symbol.dispose]();
    });
  watch(connection);
  return {
    async session() {
      if (!connection) {
        connection = await connect().catch((error: unknown) => {
          throw new Error(`${RECONNECT_FAILED}: ${String(error)}`, { cause: error });
        });
        watch(connection);
      }
      return connection.session;
    },
    // cleared first: the close this dispose causes then finds no connection for its watcher to dispose
    [Symbol.dispose]() {
      const current = connection;
      connection = undefined;
      current?.[Symbol.dispose]();
    },
  };
}

const RECONNECT_FAILED = "the session's socket closed and connecting again failed";

/** The first words of a failing sweep's page, by which the next run finds it open. */
const SWEEP_PAGE_MARKER = "context sweep failed";

/** A sweep's Slack posts: its one-line result for #ci, and its page for #error-pulse when it did
 *  not succeed or wrote no report. Destroying orphans is routine (the nightly crash hunt leaves about 14 a night), so
 *  a run that destroyed some pages no one. Pure. */
export function sweepPosts(input: {
  report: ContextSweepReport | undefined;
  /** The sweep job's result: `success`, `failure`, `cancelled`. */
  result: string;
  runUrl: string;
  testRun: boolean;
}) {
  const { report, result, testRun } = input;
  const failed = result !== "success";
  const test = testRun ? "🧪 TEST RUN — " : "";
  const run = `<${input.runUrl}|run>`;
  // No report is a failure whatever the job's result says: the sweep writes one on every run.
  if (!report) {
    const what = `${SWEEP_PAGE_MARKER} before its report (${result})`;
    return { result: `${test}🚨 ${what} · ${run}`, page: sweepPage(what, input) };
  }
  const orphanOutcomes = [
    `${report.destroyed} destroyed`,
    report.recent && `${report.recent} recent`,
    report.destroyFailed && `${report.destroyFailed} not destroyed`,
  ].filter(Boolean);
  const counts = [
    `${report.live} live`,
    `${report.global} global`,
    `${report.orphans} orphans ${report.backups ? `(${orphanOutcomes.join(", ")})` : "(report-only)"}`,
    report.emptied && `${report.emptied} emptied`,
    report.unidentified && `${report.unidentified} unidentified`,
  ].filter(Boolean);
  const head = failed
    ? `🚨 ${SWEEP_PAGE_MARKER} on ${report.env}${result === "failure" ? "" : ` (${result})`}`
    : `🧹 context sweep of ${report.env}`;
  const line = `${test}${head}: ${report.stored} objects: ${counts.join(", ")} · ${run}`;
  if (!failed) return { result: line, page: undefined };
  const failures = [
    report.unidentified && `${report.unidentified} object(s) could not say who they are`,
    report.destroyFailed && `${report.destroyFailed} orphan(s) not destroyed`,
  ].filter(Boolean);
  return {
    result: line,
    page: sweepPage(
      `${SWEEP_PAGE_MARKER} on ${report.env}: ${failures.join(", ") || `the job ended ${result}`}`,
      input,
    ),
  };
}

function sweepPage(what: string, input: { runUrl: string; testRun: boolean }) {
  return pageText({
    what,
    impact: "orphan contexts stay stored and billed until a sweep succeeds",
    action:
      "open the run: its log names each object that could not say who it is and each orphan not destroyed, with the error",
    link: input.runUrl,
    testRun: input.testRun,
  });
}

/** The backup bucket of the swept deployment (envs.ts `backupBucketEnvs`), written with the
 *  deployment's own Cloudflare API token: `put` resolves once R2 holds the backup (ci-bucket.ts
 *  `put`). Refused for a deployment without one, and for one whose bucket is on another account. */
async function backupWriter(ctx: EnvContext<OsDeployableEnv>) {
  const target = backupBucketEnvs[ctx.env.name];
  if (!target) throw new Error(`${ctx.env.name} has no backup bucket: sweep it without --destroy`);
  if (target.cloudflareAccountId !== ctx.env.cloudflareAccountId)
    throw new Error(`${target.bucketName} is not on ${ctx.env.name}'s Cloudflare account`);
  const bucket = await ciBucket({
    accountId: target.cloudflareAccountId,
    bucketName: target.bucketName,
    apiToken: ctx.secrets.CLOUDFLARE_API_TOKEN,
    area: "context-sweep",
    // a large context's backup is a few hundred megabytes: minutes on a slow link
    timeoutMs: 600_000,
  });
  return {
    bucketName: target.bucketName,
    put: (key: string, body: Uint8Array) => bucket.put(key, body, "application/x-ndjson"),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see scripts/ci/context-sweep.ts)`);
  return value;
}

void createCli({ ...import.meta, name: "context-sweep" }).run();

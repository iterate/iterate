// scripts/monitors/health.ts — THE PAGES FOR CI AND PLATFORM HEALTH: one page in #error-pulse per red
// signal. The hourly health job (`run`, .depot/workflows/health.yml) judges what the measuring
// workflows left; Main OS e2e's page job (`main-e2e`, the `alert` job of
// .depot/workflows/main-os-e2e.yml) judges its own run as soon as its suites have ended, so a red
// main pages at once. The signals:
//
//   main e2e, slow e2e rows   Main OS e2e's page job: its own push run (./e2e.ts)
//   real-model e2e            the health job: each new run of OS real model (./e2e.ts)
//   latency                   the health job: each new report of OS latency's perf suite (./latency.ts)
//   PR time to green          the health job: how long pull request pushes waited for their checks
//                             (./ttg.ts)
//   DO cost                   the health job: Durable Object hours on both accounts (./do-cost.ts), in
//                             its own daily thread and pages
//   telemetry                 the health job: the alert rules, Pipelines' dropped rows and the OTLP
//                             destinations of every telemetry lake (./telemetry.ts); after the checks,
//                             a real run on main copies the closed hours of metrics into the lake
//                             (./metrics-copy.ts)
//
// Each check returns what its verdict owes its signal's page (./page.ts `PageAction`), which
// `sendUpdates` sends. A check that could not read what it judges, or found its probe broken, fails
// the health job after the others have paged, so a page never turns a job red. Main OS e2e's page
// job has its own broken-probe rule (./e2e.ts) and fails only when it cannot judge its run or post.
//
// Each job's memory between runs is its own state artifact (`stateArtifacts`, depot.ts
// `saveNewestArtifactFile`), which only a real run on main writes, after its posts: its checks'
// memory, and the Slack ts and text of each open page. A state of another `schemaVersion` is not
// read: the job starts over, as a first run does, which may page once more a signal already paged. A
// run off main posts nothing and prints what it would; `--test-page` posts every check's verdict now
// to #ci, marked 🧪 TEST RUN and mentioning nobody, keeping no state and sending nothing to PostHog.
//
// Every command reads Depot with the organization token (../ci/depot.ts `depotApi`):
//   node scripts/monitors/health.ts await-older-runs [--workflow-id <id>]
//   node scripts/monitors/health.ts previous-state [--of main-e2e] --out <state.json>
//   node scripts/monitors/health.ts run --ref <git ref> [--state <state.json>] \
//     [--state-out <next.json>] [--test-page] [--dry-run]
//   node scripts/monitors/health.ts main-e2e --ref <git ref> [--workflow-id <id>] \
//     [--state <state.json>] [--state-out <next.json>] [--test-page] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { thisWorkflowRun } from "../ci/await-deploy.ts";
import {
  depotApi,
  saveNewestArtifactFile,
  workflowsInProgress,
  type DepotApi,
} from "../ci/depot.ts";
import { getOctokit } from "../ci/github.ts";
import { sendPostHogEvents } from "../ci/posthog-events.ts";
import {
  escalationText,
  getSlackClient,
  markResolved,
  pageChannel,
  pageText,
  resolvedText,
  updatePage,
} from "../ci/slack.ts";
import { checkDoCost } from "./do-cost.ts";
import { checkMainE2e, checkRealModel, E2eMemory, mainE2eRecords } from "./e2e.ts";
import { checkLatency, LatencyMemory } from "./latency.ts";
import { copyMetrics } from "./metrics-copy.ts";
import { SignalMemory, type PageContent, type PageUpdate } from "./page.ts";
import { checkTelemetry } from "./telemetry.ts";
import { checkTtg, TtgMemory } from "./ttg.ts";

/** Where each job leaves its state for its next run: the workflow's `name:`, its artifact, the file. */
export const stateArtifacts = {
  health: { workflow: "Health", artifact: "health-state", file: "state.json" },
  "main-e2e": { workflow: mainE2eRecords.workflow, artifact: "main-e2e-state", file: "state.json" },
};

/** Each open page, by its signal: its Slack ts in its channel, and its text as last posted, which
 *  its resolution marks resolved. */
export const OpenPages = z.record(z.string(), z.object({ ts: z.string(), text: z.string() }));
export type OpenPages = z.infer<typeof OpenPages>;

/** The health job's state. Its e2e memory is real-model e2e's: main e2e's is in MainE2eState. */
export const HealthState = z.object({
  schemaVersion: z.literal(2),
  ttg: TtgMemory,
  latency: LatencyMemory,
  e2e: E2eMemory,
  telemetry: SignalMemory.optional(),
  pages: OpenPages,
});
export type HealthState = z.infer<typeof HealthState>;

/** Main OS e2e's page job's state: main e2e's and slow e2e rows' memory, and their open pages. */
export const MainE2eState = z.object({
  schemaVersion: z.literal(3),
  e2e: E2eMemory,
  pages: OpenPages,
});
export type MainE2eState = z.infer<typeof MainE2eState>;

/** The state a health run starts from: the previous run's, or an empty one when there was none or
 *  it has another `schemaVersion`. One of this version that does not parse throws. Pure. */
export function readState(previous: unknown): HealthState {
  if (!HealthState.pick({ schemaVersion: true }).safeParse(previous).success)
    return {
      schemaVersion: 2,
      ttg: { pushes: [] },
      latency: { runs: [], red: [] },
      e2e: { suites: {}, judgedAt: {} },
      pages: {},
    };
  return HealthState.parse(previous);
}

/** readState for Main OS e2e's page job. Pure. */
export function readMainE2eState(previous: unknown): MainE2eState {
  if (!MainE2eState.pick({ schemaVersion: true }).safeParse(previous).success)
    return { schemaVersion: 3, e2e: { suites: {}, judgedAt: {} }, pages: {} };
  return MainE2eState.parse(previous);
}

/** What `sendUpdates` needs of Slack, in the pages' channel: post a message, or a reply in a
 *  page's thread (sent to the channel too when `broadcast`), answering its ts; edit one, answering
 *  "gone" when Slack can no longer edit it (../ci/slack.ts `updatePage`). */
export type PagePoster = {
  post(text: string, thread?: { ts: string; broadcast: boolean }): Promise<string>;
  update(ts: string, text: string): Promise<"edited" | "gone">;
};

/** Send the checks' updates in order, each to its signal's page in `pages`, and return the pages
 *  open after them. A resolution edits the page before it replies, so a failed edit sends no reply
 *  and the next run owes both again. An update whose signal has no open page, or whose page is
 *  gone, posts top-level: an edit or escalation a new page, with the escalation's reply in its
 *  thread; a resolution its reply, when the page is gone or the run is a test run's. A real run's
 *  resolution with no open page sends nothing: no page of this job is open to resolve. */
export async function sendUpdates(
  poster: PagePoster,
  input: { updates: PageUpdate[]; pages: OpenPages; testRun: boolean },
) {
  const pages: OpenPages = { ...input.pages };
  const { testRun } = input;
  const open = async (signal: string, text: string) => {
    const ts = await poster.post(text);
    pages[signal] = { ts, text };
    return ts;
  };
  const textOf = (page: PageContent) => pageText({ ...page, link: page.link || null, testRun });
  for (const update of input.updates) {
    const page = pages[update.signal];
    if (update.kind === "resolve" || update.kind === "replace") {
      if (page) {
        const edited = (await poster.update(page.ts, markResolved(page.text))) === "edited";
        await poster.post(
          resolvedText(update.why, testRun),
          edited ? { ts: page.ts, broadcast: false } : undefined,
        );
      } else if (testRun) await poster.post(resolvedText(update.why, testRun));
      delete pages[update.signal];
      if (update.kind === "replace") await open(update.signal, textOf(update.page));
      continue;
    }
    const text = textOf(update.page);
    const edited =
      update.kind !== "post" && page && (await poster.update(page.ts, text)) === "edited";
    const ts = edited ? page.ts : await open(update.signal, text);
    pages[update.signal] = { ts, text };
    if (update.kind === "escalate")
      await poster.post(escalationText(update.news, testRun), {
        ts,
        broadcast: update.broadcast,
      });
  }
  return pages;
}

/** The health job: run every check, send their updates to their pages, keep the state and send
 *  PostHog the checks' events; then throw when a check failed. */
export async function run(options: {
  /** The run's git ref: only refs/heads/main pages, keeps state and sends PostHog events. */
  ref: string;
  /** The previous run's state (`previous-state --out`). */
  state?: string;
  /** Where to write the state for the next run. */
  stateOut?: string;
  /** Post every check's verdict now to #ci, marked 🧪. */
  testPage?: boolean;
  /** Print the updates instead of sending them. */
  dryRun?: boolean;
}) {
  const depot = depotApi();
  const { testRun, dryRun, keep } = runMode(options);
  const state = readState(readStateFile(options.state, 2));
  const runUrl = process.env.DEPOT_JOB_URL;
  const subject = commitSubjects();
  const failures: string[] = [];
  const attempt = async <T>(name: string, check: () => Promise<T>) => {
    console.log(`\n── ${name}`);
    try {
      return await check();
    } catch (error) {
      console.error(error);
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  await attempt("DO cost", () => checkDoCost({ testRun, dryRun, runUrl }));
  const real = await attempt("real-model e2e", () =>
    checkRealModel({ depot, memory: state.e2e, testRun, subject }),
  );
  const latency = await attempt("latency", () =>
    checkLatency({ depot, memory: state.latency, testRun, subject }),
  );
  const ttg = await attempt("PR time to green", () =>
    checkTtg({ depot, memory: state.ttg, now: Date.now(), testRun, runUrl }),
  );
  const telemetry = await attempt("telemetry", () =>
    checkTelemetry({ memory: state.telemetry, testRun, runUrl, now: new Date() }),
  );
  // a write, so only a real run on main sends: any other prints what it would send
  await attempt("metrics copy", () => copyMetrics({ send: keep, now: new Date() }));
  failures.push(...(real?.failures || []), ...(latency?.failures || []));

  const realModel = real?.memory || state.e2e;
  const next: HealthState = {
    schemaVersion: 2,
    ttg: ttg?.memory || state.ttg,
    latency: latency?.memory || state.latency,
    // real-model e2e's alone: Main OS e2e keeps main e2e's
    e2e: {
      suites: { "real-model e2e": realModel.suites["real-model e2e"] },
      judgedAt: { "OS real model": realModel.judgedAt["OS real model"] },
    },
    telemetry: telemetry ? telemetry.memory : state.telemetry,
    pages: state.pages,
  };
  const updates = [
    ...(real?.updates || []),
    ...(latency?.updates || []),
    ...(ttg?.update ? [ttg.update] : []),
    ...(telemetry?.update ? [telemetry.update] : []),
  ];
  await postThenKeep({ updates, testRun, dryRun, keep, stateOut: options.stateOut, next });
  const events = [...(ttg?.events || []), ...(latency?.events || [])];
  if (!keep) console.log(`[health] ${events.length} PostHog events not sent`);
  // The iterate project in PostHog EU, as the CI telemetry sync reports to it.
  else
    await sendPostHogEvents(events, {
      apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
      host: "https://eu.i.posthog.com",
    });
  if (failures.length > 0) throw new Error(`health: ${failures.join("; ")}`);
}

/** Main OS e2e's page job (main-os-e2e.yml `alert`): judge this run (`judgeMainE2eRun`), send its
 *  updates and keep the state; then throw when a check failed. Its checks page a broken probe
 *  instead (./e2e.ts `checkMainE2e`): it throws before when it cannot judge its run or post. */
export async function mainE2e(options: {
  /** The run's git ref: only refs/heads/main pages and keeps state. */
  ref: string;
  /** The Depot workflow judged as this run: DEPOT_JOB_URL's unless given (a past run, locally). */
  workflowId?: string;
  /** The previous run's state (`previous-state --of main-e2e --out`). */
  state?: string;
  /** Where to write the state for the next run. */
  stateOut?: string;
  /** Post this run's verdicts now to #ci, marked 🧪. */
  testPage?: boolean;
  /** Print the updates instead of sending them. */
  dryRun?: boolean;
}) {
  const { testRun, dryRun, keep } = runMode(options);
  const judged = await judgeMainE2eRun({
    depot: depotApi(),
    state: readMainE2eState(readStateFile(options.state, 3)),
    workflowId: options.workflowId || thisWorkflowRun(),
    testRun,
    subject: commitSubjects(),
  });
  await postThenKeep({ ...judged, testRun, dryRun, keep, stateOut: options.stateOut });
  if (judged.failures.length > 0) throw new Error(`main e2e: ${judged.failures.join("; ")}`);
}

/** The parts of Depot's GetWorkflow answer that name a run as ListWorkflows lists it. */
const CurrentWorkflow = z.object({
  workflowId: z.string(),
  runId: z.string(),
  workflowStatus: z.string(),
  trigger: z.string().default(""),
  sha: z.string().default(""),
  workflowCreatedAt: z.iso.datetime(),
});

/** Main OS e2e's page job's verdicts: the run `workflowId`, whose deploy and suite jobs have just
 *  ended, judged after any settled push run `state` has not (./e2e.ts `checkMainE2e`), as the
 *  updates its pages owe, the state to keep once they are sent, and the broken probes. */
export async function judgeMainE2eRun(input: {
  depot: DepotApi;
  state: MainE2eState;
  workflowId: string;
  testRun: boolean;
  subject: (sha: string) => Promise<string>;
}) {
  const workflow = CurrentWorkflow.parse(
    await input.depot("GetWorkflow", { workflowId: input.workflowId }),
  );
  const judged = await checkMainE2e({
    depot: input.depot,
    memory: input.state.e2e,
    testRun: input.testRun,
    subject: input.subject,
    current: {
      workflowId: workflow.workflowId,
      runId: workflow.runId,
      status: workflow.workflowStatus,
      trigger: workflow.trigger,
      sha: workflow.sha,
      createdAt: workflow.workflowCreatedAt,
    },
  });
  const next: MainE2eState = { schemaVersion: 3, e2e: judged.memory, pages: input.state.pages };
  return { updates: judged.updates, next, failures: judged.failures };
}

/** How often Main OS e2e's page job asks Depot whether the older runs have ended, and how long it
 *  waits for them at most: a push run takes about five minutes (p50 4.8 min over 45 runs,
 *  2026-09-28/29), so an older one still in progress half an hour later is stuck. The page job's
 *  `timeout-minutes` is this bound and then its own ten (depot-workflows.test.ts). */
export const AWAIT_OLDER_RUNS = { pollMs: 10_000, boundMs: 30 * 60_000 };

/** Main OS e2e's page job's turn (main-os-e2e.yml `alert`): wait until the push runs of Main OS e2e
 *  created before this one have ended (`awaitOlderMainE2eRuns`), before `previous-state`. */
export async function awaitOlderRuns(options: {
  /** The Depot workflow whose turn it is: DEPOT_JOB_URL's unless given (a past run, locally). */
  workflowId?: string;
}) {
  await awaitOlderMainE2eRuns({
    depot: depotApi(),
    workflowId: options.workflowId || thisWorkflowRun(),
  });
}

/** THE PAGE JOBS TAKE TURNS, oldest run first. Every main commit gets its own run of Main OS e2e and
 *  runs overlap (main-os-e2e.yml `concurrency`), so each page job waits here until no push run of
 *  Main OS e2e created before its own is queued or running, asking Depot every
 *  AWAIT_OLDER_RUNS.pollMs and logging one line per change of what it waits for. It then reads the
 *  state the run before it kept and judges after it. After AWAIT_OLDER_RUNS.boundMs it throws: this
 *  run's page is then the next run's page job's, which judges it after the older ones. Runs created
 *  in the same second take turns by workflow id, so they never share a state; `judgedAt` counts
 *  whole seconds, so the later one's page job then judges nothing, as a re-run's does (./e2e.ts
 *  `judgeEachRun`). */
export async function awaitOlderMainE2eRuns(input: {
  depot: DepotApi;
  workflowId: string;
  log?: (line: string) => void;
}) {
  const { depot, log = console.log } = input;
  const current = CurrentWorkflow.parse(
    await depot("GetWorkflow", { workflowId: input.workflowId }),
  );
  const isOlder = (run: { workflowId: string; createdAt: string }) =>
    run.createdAt === current.workflowCreatedAt
      ? run.workflowId < current.workflowId
      : run.createdAt < current.workflowCreatedAt;
  const started = Date.now();
  let reported: string | undefined;
  for (;;) {
    const older = (await workflowsInProgress(depot, { name: mainE2eRecords.workflow })).filter(
      (run) => run.trigger === "push" && isOlder(run),
    );
    const waiting = older
      .map((run) => `${run.workflowId} (${run.sha.slice(0, 9)}, ${run.status})`)
      .join(", ");
    const waited = `${Math.round((Date.now() - started) / 1000)} s`;
    if (waiting !== reported)
      log(
        `[await-older-runs] ${waited}: ${waiting ? `waiting for ${waiting}` : "no older run in progress"}`,
      );
    reported = waiting;
    if (older.length === 0) return;
    if (Date.now() - started >= AWAIT_OLDER_RUNS.boundMs)
      throw new Error(
        `the older runs ${waiting} are still in progress after ${AWAIT_OLDER_RUNS.boundMs / 60_000} minutes: the next run's page job judges this run after them`,
      );
    await new Promise((resolve) => setTimeout(resolve, AWAIT_OLDER_RUNS.pollMs));
  }
}

/** What a run may do: only a run on main pages without --test-page (off main it prints instead),
 *  and only a real run on main keeps its state. */
function runMode(options: { ref: string; testPage?: boolean; dryRun?: boolean }) {
  const testRun = Boolean(options.testPage);
  const onMain = options.ref === "refs/heads/main";
  return {
    testRun,
    dryRun: Boolean(options.dryRun) || (!onMain && !testRun),
    keep: onMain && !testRun && !options.dryRun,
  };
}

/** The previous run's state file as JSON, or undefined when there is none. One of another
 *  `schemaVersion` than the reader's is logged, since the run then starts over. */
function readStateFile(path: string | undefined, schemaVersion: 2 | 3): unknown {
  if (!path || !existsSync(path)) return undefined;
  const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!z.object({ schemaVersion: z.literal(schemaVersion) }).safeParse(previous).success)
    console.log(`[health] ${path} is not a state of schemaVersion ${schemaVersion}: starting over`);
  return previous;
}

/** Send the run's updates, then keep its state with the pages open after them, in that order: a
 *  state records what was sent, so an update that could not be sent leaves the state as it was and
 *  the next run owes it again (and one sent before it, once more). A dry run prints each message
 *  instead. */
async function postThenKeep(input: {
  updates: PageUpdate[];
  testRun: boolean;
  dryRun: boolean;
  keep: boolean;
  stateOut?: string;
  next: HealthState | MainE2eState;
}) {
  if (input.updates.length === 0) console.log("\nno change of state, nothing to page");
  const pages = await sendUpdates(input.dryRun ? printingPoster() : slackPoster(input.testRun), {
    updates: input.updates,
    // a test run's posts are its own, in #ci: it never touches an open page
    pages: input.testRun ? {} : input.next.pages,
    testRun: input.testRun,
  });
  if (input.keep && input.stateOut) {
    mkdirSync(dirname(input.stateOut), { recursive: true });
    writeFileSync(input.stateOut, `${JSON.stringify({ ...input.next, pages })}\n`);
  }
}

/** The pages' channel (`pageChannel`): #error-pulse, or #ci for a test run. */
function slackPoster(testRun: boolean): PagePoster {
  const slack = getSlackClient();
  const channel = pageChannel(testRun);
  return {
    async post(text, thread) {
      // Slack's types take a broadcast reply and a plain one as two shapes
      const posted = await slack.chat.postMessage(
        thread?.broadcast
          ? { channel, text, thread_ts: thread.ts, reply_broadcast: true }
          : { channel, text, thread_ts: thread?.ts },
      );
      console.log(`[health] posted ${posted.ts}${thread ? ` in ${thread.ts}` : ""}:\n${text}`);
      return z.string().parse(posted.ts);
    },
    async update(ts, text) {
      // this job keeps its pages in its own state, so a deleted page and a frozen one are alike
      if ((await updatePage(slack, { channel, ts, text })) !== "edited") return "gone";
      console.log(`[health] edited ${ts}:\n${text}`);
      return "edited";
    },
  };
}

/** A poster that prints what it would send, for a dry run: each post answers a made-up ts. */
function printingPoster(): PagePoster {
  let posts = 0;
  return {
    async post(text, thread) {
      console.log(`\n[dry run] post${thread ? ` in ${thread.ts}` : ""}:\n${text}`);
      return `dry-run-${++posts}`;
    },
    async update(ts, text) {
      console.log(`\n[dry run] edit ${ts}:\n${text}`);
      return "edited";
    },
  };
}

/** Each commit's subject, read once from GitHub (GITHUB_TOKEN): a job's checkout holds one commit,
 *  not every commit it judges. An empty subject when GitHub cannot say. */
function commitSubjects() {
  const subjects = new Map<string, Promise<string>>();
  return (sha: string) => {
    const known = subjects.get(sha);
    if (known) return known;
    const subject = Promise.resolve()
      .then(() =>
        getOctokit().rest.repos.getCommit({ owner: "iterate", repo: "iterate", ref: sha }),
      )
      .then(({ data }) => data.commit.message.split("\n", 1)[0]!)
      .catch((error: unknown) => {
        console.warn(`[health] no subject for ${sha}: ${String(error)}`);
        return "";
      });
    subjects.set(sha, subject);
    return subject;
  };
}

/** Save the previous main run's state artifact to --out, for `--state` (or `--main-e2e-state`). */
export async function previousState(options: {
  /** Where to save the state file. */
  out: string;
  /** Whose state: the health job's (the default), or Main OS e2e's page job's. */
  of?: "health" | "main-e2e";
}) {
  console.log(
    await saveNewestArtifactFile(depotApi(), {
      ...stateArtifacts[options.of || "health"],
      out: options.out,
    }),
  );
}

void createCli({ ...import.meta, name: "health" }).run();

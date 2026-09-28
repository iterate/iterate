// scripts/monitors/health.ts — THE PAGES FOR CI AND PLATFORM HEALTH: each pages #error-pulse on a
// change of state, one message per run. The hourly health job (`run`, .depot/workflows/health.yml)
// judges what the measuring workflows left; Main OS e2e's page job (`main-e2e`, the `alert` job of
// .depot/workflows/main-os-e2e.yml) judges its own run as soon as its suites have ended, so a red
// main pages at once. The checks, in the order a message lists their pages:
//
//   main e2e, slow e2e rows   Main OS e2e's page job: its own push run (./e2e.ts)
//   real-model e2e            the health job: each new run of OS real model (./e2e.ts)
//   latency                   the health job: each new report of OS latency's perf suite (./latency.ts)
//   PR time to green          the health job: how long pull request pushes waited for their checks
//                             (./ttg.ts)
//   DO cost                   the health job: Durable Object hours on both accounts (./do-cost.ts), in
//                             its own daily thread and pages
//
// A page is one block, `🔴 <what> at <commit>` or `🟢 …`, its details as bullets and a link to the
// run that measured it; the first mentions Jonas and Misha, as every #error-pulse message does. The
// message ends with the state now of every signal the job pages; the health job's also names main
// e2e's, from Main OS e2e's state. A check that could not read what it judges, or found its probe
// broken, fails the job after the others have paged: a scheduled run reports on main's head, where
// red reads as "this commit broke", so a page never turns a job red. Main OS e2e's page job reports
// on the commit its run tested, so a broken probe of the slow rows is a ⚪ page there, on its change
// of state (./e2e.ts), and the job fails only when it cannot judge its run or post.
//
// Each job's memory between runs is its own state artifact (`stateArtifacts`, depot.ts
// `saveNewestArtifactFile`), which only a real run on main writes. A state of another `schemaVersion`
// is not read: the job starts over, as a first run does. A run off main pages nothing and prints what
// it would; `--test-page` posts every check's verdict now, marked 🧪 TEST RUN, keeping no state and
// sending nothing to PostHog.
//
//   pnpm tsx scripts/monitors/health.ts previous-state [--of main-e2e] --out <state.json>
//   DEPOT_TOKEN=… pnpm tsx scripts/monitors/health.ts run --ref <git ref> [--state <state.json>] \
//     [--main-e2e-state <state.json>] [--state-out <next.json>] [--test-page] [--dry-run]
//   DEPOT_TOKEN=… pnpm tsx scripts/monitors/health.ts main-e2e --ref <git ref> [--workflow-id <id>] \
//     [--state <state.json>] [--state-out <next.json>] [--test-page] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { depotCiApi, saveNewestArtifactFile, type DepotApi } from "../ci/depot.ts";
import { getOctokit } from "../ci/github.ts";
import { sendPostHogEvents } from "../ci/posthog-events.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "../ci/slack.ts";
import { checkDoCost } from "./do-cost.ts";
import {
  checkMainE2e,
  checkRealModel,
  E2eMemory,
  MAIN_SUITES,
  mainE2eRecords,
  type SuiteState,
} from "./e2e.ts";
import { checkLatency, LatencyMemory } from "./latency.ts";
import type { Page } from "./page.ts";
import { checkTtg, TtgMemory } from "./ttg.ts";

/** Where each job leaves its state for its next run: the workflow's `name:`, its artifact, the file.
 *  The health job reads Main OS e2e's too, for its message's last line. */
export const stateArtifacts = {
  health: { workflow: "Health", artifact: "health-state", file: "state.json" },
  "main-e2e": { workflow: mainE2eRecords.workflow, artifact: "main-e2e-state", file: "state.json" },
};

/** The health job's state. Its e2e memory is real-model e2e's: main e2e's is in MainE2eState. */
export const HealthState = z.object({
  schemaVersion: z.literal(1),
  ttg: TtgMemory,
  latency: LatencyMemory,
  e2e: E2eMemory,
});
export type HealthState = z.infer<typeof HealthState>;

/** Main OS e2e's page job's state: main e2e's and slow e2e rows' memory. Version 2 can hold slow e2e
 *  rows `broken`, which version 1's readers cannot parse. */
export const MainE2eState = z.object({ schemaVersion: z.literal(2), e2e: E2eMemory });
export type MainE2eState = z.infer<typeof MainE2eState>;

/** The state a health run starts from: the previous run's, or an empty one when there was none or
 *  it has another `schemaVersion`. One of this version that does not parse throws. Pure. */
export function readState(previous: unknown): HealthState {
  if (!HealthState.pick({ schemaVersion: true }).safeParse(previous).success)
    return {
      schemaVersion: 1,
      ttg: { pushes: [] },
      latency: { runs: [], red: [] },
      e2e: { suites: {}, judgedAt: {} },
    };
  return HealthState.parse(previous);
}

/** readState for Main OS e2e's page job. Pure. */
export function readMainE2eState(previous: unknown): MainE2eState {
  if (!MainE2eState.pick({ schemaVersion: true }).safeParse(previous).success)
    return { schemaVersion: 2, e2e: { suites: {}, judgedAt: {} } };
  return MainE2eState.parse(previous);
}

const EMOJI = { red: "🔴", green: "🟢", none: "⚪" };

/** A signal as a message's last line names it, with its state now. */
type Signal = { name: string; tone: Page["tone"] };

/** An e2e suite's state as a signal's tone: none when it is broken or has none. Pure. */
function suiteTone(state: SuiteState | undefined): Page["tone"] {
  return state === "red" || state === "green" ? state : "none";
}

/** The run's one message: each page as a block, the first mentioning Jonas and Misha, then every
 *  signal's state now. Pure. */
export function renderMessage(input: { pages: Page[]; now: Signal[]; testRun: boolean }) {
  const blocks = input.pages.flatMap((page, index) => [
    `${EMOJI[page.tone]} ${page.headline}${index === 0 ? ` ${onCallMention}` : ""}`,
    ...page.details.map((detail) => `• ${detail}`),
    ...(page.link ? [`<${page.link}|the run>`] : []),
  ]);
  const now = `now: ${input.now.map(({ name, tone }) => `${EMOJI[tone]} ${name}`).join(" · ")}`;
  return `${input.testRun ? "🧪 TEST RUN " : ""}${[...blocks, now].join("\n")}`;
}

/** The health job: run every check, post the run's one message, keep the state and send PostHog the
 *  checks' events; then throw when a check failed. */
export async function run(options: {
  /** The run's git ref: only refs/heads/main pages, keeps state and sends PostHog events. */
  ref: string;
  /** The previous run's state (`previous-state --out`). */
  state?: string;
  /** Main OS e2e's newest state (`previous-state --of main-e2e --out`), for the last line. */
  mainE2eState?: string;
  /** Where to write the state for the next run. */
  stateOut?: string;
  /** Post every check's verdict now, marked 🧪. */
  testPage?: boolean;
  /** Print the message instead of posting it. */
  dryRun?: boolean;
}) {
  const depot = depotApi();
  const { testRun, dryRun, keep } = runMode(options);
  const state = readState(readStateFile(options.state, 1));
  const mainState = readMainE2eState(readStateFile(options.mainE2eState, 2));
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
  failures.push(...(real?.failures ?? []), ...(latency?.failures ?? []));

  const realModel = real?.memory ?? state.e2e;
  const next: HealthState = {
    schemaVersion: 1,
    ttg: ttg?.memory ?? state.ttg,
    latency: latency?.memory ?? state.latency,
    // real-model e2e's alone: Main OS e2e keeps main e2e's
    e2e: {
      suites: { "real-model e2e": realModel.suites["real-model e2e"] },
      judgedAt: { "OS real model": realModel.judgedAt["OS real model"] },
    },
  };
  const pages = [
    ...(real?.pages ?? []),
    ...(latency?.pages ?? []),
    ...(ttg?.page ? [ttg.page] : []),
  ];
  const text =
    pages.length > 0 &&
    renderMessage({
      pages,
      now: [
        ...MAIN_SUITES.map((suite): Signal => ({
          name: suite,
          tone: suiteTone(mainState.e2e.suites[suite]),
        })),
        {
          name: "real-model e2e",
          tone: suiteTone(next.e2e.suites["real-model e2e"]),
        },
        {
          name: "latency",
          tone: next.latency.red.length > 0 ? "red" : "green",
        },
        { name: "PR time to green", tone: ttg?.status ?? "none" },
      ],
      testRun,
    });
  await postThenKeep({ text, dryRun, keep, stateOut: options.stateOut, next });
  const events = [...(ttg?.events ?? []), ...(latency?.events ?? [])];
  if (!keep) console.log(`[health] ${events.length} PostHog events not sent`);
  // The iterate project in PostHog EU, as the CI telemetry sync reports to it.
  else
    await sendPostHogEvents(events, {
      apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
      host: "https://eu.i.posthog.com",
    });
  if (failures.length > 0) throw new Error(`health: ${failures.join("; ")}`);
}

/** Main OS e2e's page job (main-os-e2e.yml `alert`): judge this run (`judgeMainE2eRun`), post its
 *  message and keep the state; then throw when a check failed. Its checks page a broken probe
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
  /** Post this run's verdicts now, marked 🧪. */
  testPage?: boolean;
  /** Print the message instead of posting it. */
  dryRun?: boolean;
}) {
  const { testRun, dryRun, keep } = runMode(options);
  const judged = await judgeMainE2eRun({
    depot: depotApi(),
    state: readMainE2eState(readStateFile(options.state, 2)),
    workflowId:
      options.workflowId ||
      z
        .string()
        .regex(/^[a-z0-9]+$/u)
        .parse(new URL(z.url().parse(process.env.DEPOT_JOB_URL)).pathname.split("/").at(-1)),
    testRun,
    subject: commitSubjects(),
  });
  await postThenKeep({ ...judged, dryRun, keep, stateOut: options.stateOut });
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
 *  message to post (or false, for no change of state), the state to keep and the broken probes. */
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
  const next: MainE2eState = { schemaVersion: 2, e2e: judged.memory };
  const text =
    judged.pages.length > 0 &&
    renderMessage({
      pages: judged.pages,
      now: MAIN_SUITES.map((suite): Signal => ({
        name: suite,
        tone: suiteTone(next.e2e.suites[suite]),
      })),
      testRun: input.testRun,
    });
  return { text, next, failures: judged.failures };
}

/** The Depot CI API with the organization token (Doppler _shared/preview) bound. */
function depotApi(): DepotApi {
  const token = z
    .string({ error: "DEPOT_TOKEN is required (Doppler _shared/preview)" })
    .min(1)
    .parse(process.env.DEPOT_TOKEN);
  return (method, body) => depotCiApi(method, body, token);
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
function readStateFile(path: string | undefined, schemaVersion: 1 | 2): unknown {
  if (!path || !existsSync(path)) return undefined;
  const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!z.object({ schemaVersion: z.literal(schemaVersion) }).safeParse(previous).success)
    console.log(`[health] ${path} is not a state of schemaVersion ${schemaVersion}: starting over`);
  return previous;
}

/** Post the run's message, then keep its state, in that order: a state records what was posted, so a
 *  message that could not post leaves the state as it was and the next run owes it again. */
async function postThenKeep(input: {
  text: string | false;
  dryRun: boolean;
  keep: boolean;
  stateOut?: string;
  next: HealthState | MainE2eState;
}) {
  console.log(input.text ? `\n${input.text}\n` : "\nno change of state, nothing to page");
  if (input.text && !input.dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: input.text,
    });
  if (input.keep && input.stateOut) {
    mkdirSync(dirname(input.stateOut), { recursive: true });
    writeFileSync(input.stateOut, `${JSON.stringify(input.next)}\n`);
  }
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
    await saveNewestArtifactFile({ ...stateArtifacts[options.of || "health"], out: options.out }),
  );
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "health" }).run();

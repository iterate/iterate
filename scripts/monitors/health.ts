// scripts/monitors/health.ts — THE HEALTH JOB (.depot/workflows/health.yml, hourly): one scheduled
// job that judges what the measuring workflows left and pages #error-pulse on a change of state, in
// one message per run. Its checks, in the order the message lists their pages:
//
//   main e2e, slow e2e rows   the newest push run of Main OS e2e (./e2e.ts)
//   real-model e2e            the newest run of OS real model (./e2e.ts)
//   latency                   each new report of OS latency's perf suite (./latency.ts)
//   PR time to green          how long pull request pushes waited for their checks (./ttg.ts)
//   DO cost                   Durable Object hours on both accounts (./do-cost.ts), in its own daily
//                             thread and pages, as before the fold
//
// A page is one block, `🔴 <what> at <commit>` or `🟢 …`, its details as bullets and a link to the
// run that measured it; a red one mentions Jonas once. The message ends with every signal's state now.
// A check that could not read what it judges, or found its probe broken, fails the run after the
// others have paged, and keeps its memory as it was: a scheduled run reports on main's head, where
// red reads as "this commit broke", so a page never turns the run red.
//
// The memory between runs is one `health-state` artifact (depot.ts `saveNewestArtifactFile`), which
// only a real run on main writes. A state of another `schemaVersion` is not read: the run starts
// over, as a first run does. A run off main pages nothing and prints what it would; `--test-page`
// posts every check's verdict now, marked 🧪 TEST RUN, mentioning nobody, keeping no state and
// sending nothing to PostHog.
//
//   pnpm tsx scripts/monitors/health.ts previous-state --out <state.json>
//   DEPOT_TOKEN=… pnpm tsx scripts/monitors/health.ts run --ref <git ref> [--state <state.json>] \
//     [--state-out <next.json>] [--test-page] [--dry-run]
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
import { checkMainE2e, checkRealModel, E2eMemory, SUITES } from "./e2e.ts";
import { checkLatency, LatencyMemory } from "./latency.ts";
import type { Page } from "./page.ts";
import { checkTtg, TtgMemory } from "./ttg.ts";

/** Where one run leaves its state for the next: the workflow's `name:`, its artifact, the file. */
export const stateArtifact = { workflow: "Health", artifact: "health-state", file: "state.json" };

export const HealthState = z.object({
  schemaVersion: z.literal(1),
  ttg: TtgMemory,
  latency: LatencyMemory,
  e2e: E2eMemory,
});
export type HealthState = z.infer<typeof HealthState>;

/** The state a run starts from: the previous run's, or an empty one when there was none or it has
 *  another `schemaVersion`. One of this version that does not parse throws. Pure. */
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

const EMOJI = { red: "🔴", green: "🟢", none: "⚪" };

/** The run's one message: each page as a block, the first red one mentioning Jonas (a test run
 *  mentions nobody), then every signal's state now. Pure. */
export function renderMessage(input: {
  pages: Page[];
  now: { name: string; tone: Page["tone"] }[];
  testRun: boolean;
}) {
  const mentioned = input.testRun ? undefined : input.pages.find((page) => page.tone === "red");
  const blocks = input.pages.flatMap((page) => [
    `${EMOJI[page.tone]} ${page.headline}${page === mentioned ? ` ${onCallMention}` : ""}`,
    ...page.details.map((detail) => `• ${detail}`),
    ...(page.link ? [`<${page.link}|the run>`] : []),
  ]);
  const now = `now: ${input.now.map(({ name, tone }) => `${EMOJI[tone]} ${name}`).join(" · ")}`;
  return `${input.testRun ? "🧪 TEST RUN " : ""}${[...blocks, now].join("\n")}`;
}

/** Run every check, post the run's one message, keep the state and send PostHog the checks'
 *  events; then throw when a check failed. */
export async function run(options: {
  /** The run's git ref: only refs/heads/main pages, keeps state and sends PostHog events. */
  ref: string;
  /** The previous run's state (`previous-state --out`). */
  state?: string;
  /** Where to write the state for the next run. */
  stateOut?: string;
  /** Post every check's verdict now, marked 🧪, mentioning nobody. */
  testPage?: boolean;
  /** Print the message instead of posting it. */
  dryRun?: boolean;
}) {
  const token = z
    .string({ error: "DEPOT_TOKEN is required (Doppler _shared/preview)" })
    .min(1)
    .parse(process.env.DEPOT_TOKEN);
  const depot: DepotApi = (method, body) => depotCiApi(method, body, token);
  const testRun = Boolean(options.testPage);
  const onMain = options.ref === "refs/heads/main";
  // Off main only a test page posts: every other page is main's.
  const dryRun = Boolean(options.dryRun) || (!onMain && !testRun);
  const keep = onMain && !testRun && !options.dryRun;
  const previous =
    options.state && existsSync(options.state)
      ? JSON.parse(readFileSync(options.state, "utf8"))
      : undefined;
  const state = readState(previous);
  if (previous && previous.schemaVersion !== state.schemaVersion)
    console.log(
      `[health] the previous state has schemaVersion ${previous.schemaVersion}, not ${state.schemaVersion}: starting over`,
    );
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
  const main = await attempt("main e2e", () =>
    checkMainE2e({ depot, memory: state.e2e, testRun, subject }),
  );
  const real = await attempt("real-model e2e", () =>
    checkRealModel({ depot, memory: main?.memory ?? state.e2e, testRun, subject }),
  );
  const latency = await attempt("latency", () =>
    checkLatency({ depot, memory: state.latency, testRun, subject }),
  );
  const ttg = await attempt("PR time to green", () =>
    checkTtg({ depot, memory: state.ttg, now: Date.now(), testRun, runUrl }),
  );
  failures.push(...(main?.failures ?? []), ...(real?.failures ?? []), ...(latency?.failures ?? []));

  const next: HealthState = {
    schemaVersion: 1,
    ttg: ttg?.memory ?? state.ttg,
    latency: latency?.memory ?? state.latency,
    e2e: real?.memory ?? main?.memory ?? state.e2e,
  };
  const pages = [
    ...(main?.pages ?? []),
    ...(real?.pages ?? []),
    ...(latency?.pages ?? []),
    ...(ttg?.page ? [ttg.page] : []),
  ];
  const text =
    pages.length > 0 &&
    renderMessage({
      pages,
      now: [
        ...SUITES.map((suite) => ({
          name: suite,
          tone: next.e2e.suites[suite] ?? ("none" as const),
        })),
        {
          name: "latency",
          tone: next.latency.red.length > 0 ? ("red" as const) : ("green" as const),
        },
        { name: "PR time to green", tone: ttg?.status ?? ("none" as const) },
      ],
      testRun,
    });
  console.log(text ? `\n${text}\n` : "\nhealth: no change of state, nothing to page");

  // The order is the state's: the message first, since a state it records must have been posted (a
  // message that could not post leaves the state as it was, so the next run owes it again); then
  // the state, so a PostHog outage does not cost the job its memory; then PostHog.
  if (text && !dryRun)
    await getSlackClient().chat.postMessage({ channel: slackChannelIds["#error-pulse"], text });
  if (keep && options.stateOut) {
    mkdirSync(dirname(options.stateOut), { recursive: true });
    writeFileSync(options.stateOut, `${JSON.stringify(next)}\n`);
  }
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

/** Each commit's subject, read once from GitHub (GITHUB_TOKEN): the health job checks out main's
 *  head, not the commits it judges. An empty subject when GitHub cannot say. */
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

/** Save the previous main run's state artifact to --out, for `run --state`. */
export async function previousState(options: {
  /** Where to save the state file. */
  out: string;
}) {
  console.log(await saveNewestArtifactFile({ ...stateArtifact, out: options.out }));
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "health" }).run();

// scripts/ci/pr-ttg-guard.ts — PR TIME TO GREEN (.depot/workflows/pr-ttg.yml, hourly): how long a
// pull request's push waits for its checks, read from Depot's records, and a page to #error-pulse when
// that gets slow.
//
// A PUSH is a Depot run of a pull request that runs Test: its ref is `refs/pull/<n>/merge`. Its
// CHECKS are Lint and Typecheck, Test and Preview OS, whose E2E tests and Browser specs jobs the main
// ruleset requires with the other two, and which runs on every push since 2026-09-24 (on those that
// touched the preview's paths before). Each push is measured once it settled:
//   • TIME TO FIRST VERDICT: from the run's creation (about the push, and where the CI trace's clock
//     starts) to the end of the last check's first execution, the Preview OS trace job included, and
//     a Preview OS that queued behind the PR's previous run. A red run, and one whose checks were
//     re-run, counts at its first execution's end, so a flake costs what it costs.
//   • TIME TO GREEN: the same, for the pushes whose checks all passed on their first execution.
// A push whose Test or Lint was cancelled because the PR's next push superseded it has no verdict and
// is left out. Any other cancel, a job's timeout say, is red.
//
// Pushes are split by what their Preview OS E2E tests job ran, from its suite summary (`slowRows` in
// packages/shared/src/test-support/flake-suite-summary.ts):
//   slow rows skipped   the e2e rows tagged `slow` were left out, as they are for most PRs
//   every row           they ran: the PR touched their code, or the summary predates the tag
//   no summary          e2e wrote none (its deploy failed, say), so which rows would have run is unknown
//   no Preview OS       no preview: the push changed no preview path, so E2E tests skipped, or it
//                       ran no Preview OS at all
//
// THE PAGE: when the time to green of the pushes that skipped the slow rows, over the last 24 hours
// and at least 20 of them, has a median over 165 s or a p90 over 200 s, #error-pulse is paged red,
// once; green once when both are back under their lines. Fewer pushes change nothing. The lines are
// defaults for the owner to confirm. A page leaves the run green (a scheduled run reports on main's
// head, where red reads as "this commit broke"); failing to read Depot fails it.
//
// The memory between runs is the previous main run's `pr-ttg-state` artifact (depot.ts
// `saveNewestArtifactFile`): the pushes of the last 7 days as measured, and what the channel was last
// told. Each run lists the PR runs of the last 26 hours and measures those it has not. Every push it
// measures is also a PostHog event, `pr checks settled`. A run off main, or with `--test-page`, keeps
// no state and sends nothing to PostHog; `--test-page` posts its numbers marked 🧪, mentioning nobody.
//
//   pnpm tsx scripts/ci/pr-ttg-guard.ts previous-state --out <state.json>
//   DEPOT_TOKEN=… pnpm tsx scripts/ci/pr-ttg-guard.ts measure --ref <git ref> [--state <state.json>] \
//     [--state-out <next.json>] [--test-page] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import { z } from "zod";
import { osEnvs } from "../../envs.ts";
import { depotCiApi, mapConcurrent, saveNewestArtifactFile, unzip } from "./depot.ts";
import { sendPostHogEvents, systemEvent } from "./posthog-events.ts";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";

/** The page's lines on the time to green of the pushes that skipped the slow rows, in seconds, and
 *  the fewest such pushes in the last 24 hours it judges. Defaults: the owner has yet to confirm them. */
export const LINES = { p50: 165, p90: 200, minPushes: 20 };
/** Where one run leaves its state for the next: the workflow's `name:`, its artifact, the file in it. */
export const stateArtifact = {
  workflow: "PR time to green",
  artifact: "pr-ttg-state",
  file: "state.json",
};
/** The checks a push waits for, by their workflows' `name:`, which outlived preview-os-next.yml's
 *  rename to preview-os.yml. LOC report and the PR dashboard gate nothing and finish within a
 *  minute; Kit Firmware runs only on firmware PRs. */
export const CHECKS = ["Lint and Typecheck", "Test", "Preview OS"];
const HOUR_MS = 3_600_000;

const E2eRows = z.enum(["slow-rows-skipped", "every-row", "no-summary", "no-preview"]);
type E2eRows = z.infer<typeof E2eRows>;
const pushFields = { run: z.string(), pr: z.number().int(), createdAt: z.iso.datetime() };
/** One settled PR run as the state remembers it. Runs without a verdict are kept too, so the next
 *  run does not read them again. */
const Push = z.discriminatedUnion("outcome", [
  z.object({
    ...pushFields,
    outcome: z.enum(["green", "red"]),
    e2e: E2eRows,
    /** The time to first verdict; for a green push, its time to green. */
    seconds: z.number().nonnegative(),
  }),
  z.object({ ...pushFields, outcome: z.enum(["superseded", "not-a-push"]) }),
]);
type Push = z.infer<typeof Push>;

export const TtgState = z.object({
  schemaVersion: z.literal(1),
  pushes: z.array(Push),
  /** What #error-pulse was last told: `over` in red, `under` in green. */
  paged: z.enum(["over", "under"]),
});
export type TtgState = z.infer<typeof TtgState>;

/** One settled run as a push. `firstExecutions` holds each re-run check's first execution, by
 *  workflow id (Depot's `GetWorkflow`); `nextRunAt` is when the PR's next run was created, if one
 *  was; `summary` is the Preview OS e2e suite summary, if e2e wrote one. Undefined for a run with a
 *  check that has not finished. Pure. */
export function measurePush(input: {
  metrics: RunMetrics;
  firstExecutions: Record<string, { status: string; finishedAt: string }>;
  nextRunAt: string | undefined;
  summary: { slowRows?: "ran" | "skipped" } | undefined;
}): Push | undefined {
  const { run, workflows } = input.metrics;
  const base = { run: run.runId, pr: Number(run.ref.split("/")[2]), createdAt: run.createdAt };
  const checks = workflows
    .filter(({ workflow }) => CHECKS.includes(workflow.name))
    .map(({ workflow }) => ({
      name: workflow.name,
      ...(input.firstExecutions[workflow.workflowId] || workflow),
    }));
  if (!checks.some((check) => check.name === "Test")) return { ...base, outcome: "not-a-push" };
  if (checks.some((check) => !check.finishedAt)) return undefined;
  // Lint and Test cancel a run in progress when the PR's next push starts (their `concurrency:`);
  // Preview OS never does, so its cancel is always a timeout or a person.
  const nextRunAt = input.nextRunAt ? Date.parse(input.nextRunAt) : Infinity;
  if (
    checks.some(
      (check) =>
        check.name !== "Preview OS" &&
        check.status === "cancelled" &&
        nextRunAt <= Date.parse(check.finishedAt),
    )
  )
    return { ...base, outcome: "superseded" };
  const verdictAt = Math.max(...checks.map((check) => Date.parse(check.finishedAt)));
  return {
    ...base,
    outcome: checks.every((check) => check.status === "finished") ? "green" : "red",
    e2e: !previewTested(workflows)
      ? "no-preview"
      : !input.summary
        ? "no-summary"
        : input.summary.slowRows === "skipped"
          ? "slow-rows-skipped"
          : "every-row",
    seconds: Math.round((verdictAt - Date.parse(run.createdAt)) / 100) / 10,
  };
}

/** Whether the push's Preview OS tested a preview: it ran, and its E2E tests job was not skipped,
 *  as it is for a push that changes no preview path (preview-os.yml). Pure. */
function previewTested(workflows: RunMetrics["workflows"]) {
  const preview = workflows.find(({ workflow }) => workflow.name === "Preview OS");
  return (
    !!preview &&
    !preview.jobs.some(
      ({ job }) => job?.jobKey === "preview-os.yml:e2e" && job.status === "skipped",
    )
  );
}

/** The pushes created in [from, to), by what their e2e ran and all together: each group's time to
 *  green and time to first verdict (p50 and p90, linearly interpolated), and how many were red.
 *  Pure. */
export function summarizePushes(pushes: Push[], window: { from: number; to: number }) {
  const inWindow = pushes.filter((push) => {
    const createdAt = Date.parse(push.createdAt);
    return createdAt >= window.from && createdAt < window.to;
  });
  const verdicts = inWindow.flatMap((push) =>
    push.outcome === "green" || push.outcome === "red" ? [push] : [],
  );
  const group = (e2e?: E2eRows) => {
    const members = verdicts.filter((push) => !e2e || push.e2e === e2e);
    return {
      pushes: members.length,
      red: members.filter((push) => push.outcome === "red").length,
      timeToGreen: percentiles(
        members.filter((push) => push.outcome === "green").map((push) => push.seconds),
      ),
      firstVerdict: percentiles(members.map((push) => push.seconds)),
    };
  };
  const byRows = {
    "slow-rows-skipped": group("slow-rows-skipped"),
    "every-row": group("every-row"),
    "no-summary": group("no-summary"),
    "no-preview": group("no-preview"),
  };
  const slowRowsKnown = byRows["every-row"].pushes + byRows["slow-rows-skipped"].pushes;
  return {
    ...window,
    byRows,
    all: group(),
    /** Of the Preview OS pushes whose e2e said which rows it ran, the share that ran the slow rows. */
    slowRowsShare: slowRowsKnown ? byRows["every-row"].pushes / slowRowsKnown : undefined,
    superseded: inWindow.filter((push) => push.outcome === "superseded").length,
  };
}
type PushSummary = ReturnType<typeof summarizePushes>;

/** The last 24 hours against LINES: `over` when the time to green of the pushes that skipped the
 *  slow rows crossed either line, `too-few` below LINES.minPushes of them. Pure. */
export function judge(summary: PushSummary): "over" | "under" | "too-few" {
  const green = summary.byRows["slow-rows-skipped"].timeToGreen;
  if (!green || green.n < LINES.minPushes) return "too-few";
  return green.p50 > LINES.p50 || green.p90 > LINES.p90 ? "over" : "under";
}

/** The page a judgement owes the channel, which was last told `paged`, if any. Pure. */
export function pageFor(paged: TtgState["paged"], judgement: ReturnType<typeof judge>) {
  return judgement === "too-few" || judgement === paged ? null : judgement;
}

/** The Slack message: the judgement, then each group of the last 24 hours. Only a test page is
 *  ever `too-few`. Pure. */
export function renderPage(input: {
  page: ReturnType<typeof judge>;
  summary: PushSummary;
  runUrl?: string;
  testRun: boolean;
}) {
  const green = input.summary.byRows["slow-rows-skipped"].timeToGreen;
  const numbers = green
    ? `p50 ${seconds(green.p50)} (line ${LINES.p50} s), p90 ${seconds(green.p90)} (line ${LINES.p90} s), n=${green.n}`
    : "none green";
  const heading = {
    over: `🔴 PR time to green over its lines${input.testRun ? "" : ` ${onCallMention}`}`,
    under: "🟢 PR time to green back under its lines",
    "too-few": `⚪ PR time to green not judged below ${LINES.minPushes} pushes`,
  }[input.page];
  return [
    `${input.testRun ? "🧪 TEST RUN " : ""}${heading}: pushes that skipped the slow rows, last 24 h: ${numbers}`,
    ...renderGroups(input.summary),
    input.runUrl && `<${input.runUrl}|the run>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One line per group and a closing line on the slow rows' share, for the page and the log. Pure. */
function renderGroups(summary: PushSummary) {
  const names: Record<E2eRows, string> = {
    "slow-rows-skipped": "Preview OS, slow rows skipped",
    "every-row": "Preview OS, every row",
    "no-summary": "Preview OS, no e2e summary",
    "no-preview": "no Preview OS",
  };
  const line = (name: string, { pushes, red, timeToGreen, firstVerdict }: PushSummary["all"]) => {
    if (!firstVerdict) return `• ${name}: no pushes`;
    const green = timeToGreen
      ? `time to green p50 ${seconds(timeToGreen.p50)}, p90 ${seconds(timeToGreen.p90)} (n=${timeToGreen.n})`
      : "none green";
    return `• ${name}: ${green}; first verdict p50 ${seconds(firstVerdict.p50)}, p90 ${seconds(firstVerdict.p90)} (n=${pushes}, ${Math.round((red / pushes) * 100)} % red)`;
  };
  return [
    ...E2eRows.options.map((rows) => line(names[rows], summary.byRows[rows])),
    line("every push", summary.all),
    `slow rows ran in ${summary.slowRowsShare === undefined ? "–" : `${Math.round(summary.slowRowsShare * 100)} %`} of Preview OS pushes; ${summary.superseded} superseded pushes left out`,
  ];
}

/** One PostHog event per push with a verdict, deduplicated per run. Pure. */
export function pushEvents(pushes: Push[]) {
  return pushes.flatMap((push) =>
    push.outcome === "green" || push.outcome === "red"
      ? [
          systemEvent(
            "pr checks settled",
            `pr-ttg:${push.run}`,
            `depot-run:${push.run}`,
            {
              pull_request_number: push.pr,
              depot_run_id: push.run,
              outcome: push.outcome,
              e2e_rows: push.e2e,
              time_to_first_verdict_s: push.seconds,
              time_to_green_s: push.outcome === "green" ? push.seconds : undefined,
              created_at: push.createdAt,
            },
            new Date(Date.parse(push.createdAt) + push.seconds * 1000).toISOString(),
          ),
        ]
      : [],
  );
}

async function measure(options: {
  token: string;
  ref: string;
  state?: string;
  stateOut?: string;
  testPage: boolean;
  dryRun: boolean;
}) {
  const depot = (method: string, body: object) => depotCiApi(method, body, options.token);
  const testRun = options.testPage || options.ref !== "refs/heads/main";
  const now = Date.now();
  const state: TtgState =
    options.state && existsSync(options.state)
      ? TtgState.parse(JSON.parse(readFileSync(options.state, "utf8")))
      : { schemaVersion: 1, pushes: [], paged: "under" };

  // 26 hours: the page's 24, and two for a run that settled late or an hourly run that failed.
  const listed = await listPullRequestRuns(depot, now - 26 * HOUR_MS);
  const known = new Set(state.pushes.map((push) => push.run));
  const toMeasure = listed.filter(
    (run) => ["finished", "failed", "cancelled"].includes(run.status) && !known.has(run.runId),
  );
  const measured = (
    await mapConcurrent(toMeasure, 8, async (run) =>
      measurePush({
        ...(await readRun(depot, run.runId)),
        nextRunAt: listed
          .filter(
            (next) =>
              next.ref === run.ref && Date.parse(next.createdAt) > Date.parse(run.createdAt),
          )
          .map((next) => next.createdAt)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0],
      }),
    )
  ).flatMap((push) => (push ? [push] : []));
  const pushes = [...state.pushes, ...measured].filter(
    (push) => Date.parse(push.createdAt) >= now - 7 * 24 * HOUR_MS,
  );
  console.log(
    `[pr-ttg] listed ${listed.length} PR runs since ${new Date(now - 26 * HOUR_MS).toISOString()}, measured ${measured.length} new, ${pushes.length} pushes in the last 7 days`,
  );

  const week = summarizePushes(pushes, { from: now - 7 * 24 * HOUR_MS, to: now });
  const day = summarizePushes(pushes, { from: now - 24 * HOUR_MS, to: now });
  console.log(
    ["last 7 days:", ...renderGroups(week), "last 24 hours:", ...renderGroups(day)].join("\n"),
  );
  const judgement = judge(day);
  const change = pageFor(state.paged, judgement);
  // A test page shows this run's judgement whatever the channel was last told; any other run off
  // main pages nothing.
  const page = testRun ? (options.testPage ? judgement : null) : change;
  const text =
    page && renderPage({ page, summary: day, runUrl: process.env.DEPOT_JOB_URL, testRun });
  console.log(JSON.stringify({ testRun, judgement, paged: state.paged, page }));
  if (text) console.log(`\n${text}\n`);
  else console.log("pr-ttg: no change of state, nothing to page");

  // The order is the state's: the page first, since a colour the state records must have been
  // posted (a page that could not post leaves the state as it was, so the next run owes it again);
  // then the state, so a PostHog outage does not cost the guard its memory; then PostHog.
  if (text && !options.dryRun)
    await getSlackClient().chat.postMessage({ channel: slackChannelIds["#error-pulse"], text });
  if (testRun) return;
  if (options.stateOut) {
    const next: TtgState = { schemaVersion: 1, pushes, paged: change || state.paged };
    mkdirSync(dirname(options.stateOut), { recursive: true });
    writeFileSync(options.stateOut, `${JSON.stringify(next)}\n`);
  }
  const events = pushEvents(measured);
  if (options.dryRun) return console.log(`dry run: ${events.length} PostHog events not sent`);
  // The iterate project in PostHog EU, as the CI telemetry sync reports to it.
  await sendPostHogEvents(events, {
    apiKey: z.string().parse(osEnvs.prd?.posthogProjectKey),
    host: "https://eu.i.posthog.com",
  });
}

/** Every PR run created since `since`, newest first, whatever its status: Depot's `ListRuns` pages
 *  back from the newest (https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto).
 *  A closed PR's run has its merge commit for a ref and is left out. */
async function listPullRequestRuns(
  depot: (method: string, body: object) => Promise<unknown>,
  since: number,
) {
  const runs: z.infer<typeof RunPage>["runs"] = [];
  for (let pageToken = ""; ; ) {
    const page = RunPage.parse(
      await depot("ListRuns", {
        repo: "iterate/iterate",
        trigger: "pull_request",
        status: ["queued", "running", "finished", "failed", "cancelled"],
        pageSize: 100,
        pageToken,
      }),
    );
    runs.push(...page.runs);
    const oldest = page.runs.at(-1);
    if (!page.nextPageToken || !oldest || Date.parse(oldest.createdAt) < since) break;
    pageToken = page.nextPageToken;
  }
  return runs.filter(
    (run) => Date.parse(run.createdAt) >= since && /^refs\/pull\/\d+\/merge$/.test(run.ref),
  );
}

/** What `measurePush` reads of one run: its workflows and jobs, the first execution of each check
 *  that was re-run, and the Preview OS e2e suite summary. */
async function readRun(depot: (method: string, body: object) => Promise<unknown>, runId: string) {
  const metrics = RunMetrics.parse(await depot("GetRunMetrics", { runId }));
  const checks = metrics.workflows.filter(({ workflow }) => CHECKS.includes(workflow.name));
  // A re-run is a new execution whose jobs run as new attempts: only GetWorkflow keeps the first.
  const firstExecutions = Object.fromEntries(
    await Promise.all(
      checks
        .filter(({ jobs }) => jobs.some((job) => job.attempts.length > 1))
        .map(async ({ workflow }) => {
          const { executions } = WorkflowExecutions.parse(
            await depot("GetWorkflow", { workflowId: workflow.workflowId }),
          );
          const first = executions.find((execution) => execution.execution === 1);
          if (!first) throw new Error(`Depot lists no first execution of ${workflow.workflowId}`);
          return [workflow.workflowId, first] as const;
        }),
    ),
  );
  const preview = checks.find(({ workflow }) => workflow.name === "Preview OS");
  return {
    metrics,
    firstExecutions,
    summary: preview && (await readE2eSummary(depot, runId, preview.workflow.workflowId)),
  };
}

/** The suite summary of the Preview OS e2e job's first attempt (preview-os.yml uploads it as
 *  `flake-records-preview-e2e-attempt-<id>`), or undefined when it uploaded none. */
async function readE2eSummary(
  depot: (method: string, body: object) => Promise<unknown>,
  runId: string,
  workflowId: string,
) {
  // One page: a Preview OS workflow uploads about eight artifacts per execution.
  const { artifacts } = ArtifactPage.parse(
    await depot("ListArtifacts", { runId, workflowId, pageSize: 500 }),
  );
  const artifact = artifacts
    .filter((candidate) => candidate.name.startsWith("flake-records-preview-e2e"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!artifact) return undefined;
  const { url } = z
    .object({ url: z.url() })
    .parse(await depot("GetArtifactDownloadURL", { artifactId: artifact.artifactId }));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${artifact.name} download returned HTTP ${response.status}`);
  const { "suite-summary.json": bytes } = await unzip(new Uint8Array(await response.arrayBuffer()));
  // A cancelled e2e job uploads its records without a summary.
  if (!bytes) return undefined;
  return z
    .object({ slowRows: FlakeSuiteSummary.shape.slowRows })
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** p50 and p90 of `values` to a tenth, linearly interpolated between the closest ranks (numpy's
 *  default), or undefined for none. */
function percentiles(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => {
    const rank = (sorted.length - 1) * q;
    const low = sorted[Math.floor(rank)]!;
    const value = low + (sorted[Math.ceil(rank)]! - low) * (rank - Math.floor(rank));
    return Math.round(value * 10) / 10;
  };
  return { n: sorted.length, p50: at(0.5), p90: at(0.9) };
}

function seconds(value: number) {
  return `${Math.round(value)} s`;
}

// Connect's JSON encoding omits empty strings and lists, so an unset field is absent rather than "":
// https://protobuf.dev/programming-guides/json/ ("default values are omitted").
const RunPage = z.object({
  runs: z
    .array(
      z.object({
        runId: z.string(),
        ref: z.string().default(""),
        status: z.string(),
        createdAt: z.iso.datetime(),
      }),
    )
    .default([]),
  nextPageToken: z.string().default(""),
});

const RunMetrics = z.object({
  run: z.object({
    runId: z.string(),
    ref: z.string().regex(/^refs\/pull\/\d+\/merge$/),
    createdAt: z.iso.datetime(),
  }),
  workflows: z
    .array(
      z.object({
        workflow: z.object({
          workflowId: z.string(),
          name: z.string().default(""),
          status: z.string(),
          finishedAt: z.string().default(""),
        }),
        jobs: z
          .array(
            z.object({
              job: z.object({ jobKey: z.string(), status: z.string() }).optional(),
              attempts: z.array(z.unknown()).default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

const WorkflowExecutions = z.object({
  executions: z.array(
    z.object({ execution: z.number(), status: z.string(), finishedAt: z.string().default("") }),
  ),
});

const ArtifactPage = z.object({
  artifacts: z
    .array(z.object({ artifactId: z.string(), name: z.string(), createdAt: z.iso.datetime() }))
    .default([]),
});

if (isMainModule(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      ref: { type: "string" },
      state: { type: "string" },
      "state-out": { type: "string" },
      "test-page": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const done =
    positionals[0] === "previous-state" && values.out
      ? saveNewestArtifactFile({ ...stateArtifact, out: values.out }).then(console.log)
      : positionals[0] === "measure" && values.ref
        ? measure({
            token: z
              .string({ error: "DEPOT_TOKEN is required (Doppler _shared/preview)" })
              .min(1)
              .parse(process.env.DEPOT_TOKEN),
            ref: values.ref,
            state: values.state,
            stateOut: values["state-out"],
            testPage: values["test-page"],
            dryRun: values["dry-run"],
          })
        : Promise.reject(
            new Error(
              "usage: pr-ttg-guard.ts previous-state --out <file> | measure --ref <ref> [--state <file>] [--state-out <file>] [--test-page] [--dry-run]",
            ),
          );
  done.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

// scripts/monitors/telemetry.ts — THE TELEMETRY ALERTS, one check of the hourly health job
// (./health.ts), on every account envs.ts `telemetryEnvs` names (docs/telemetry.md):
//   rules          each of ALERT_RULES, one flat Analytics Engine query over the lake's one judged
//                  Worker (envs.ts `alertRulesWorkerName`), against its line
//   pipelines      each of the lake's four pipelines that is missing or not running
//   dropped rows   Basin Pipelines' user errors: rows one of the lake's streams accepted and dropped
//   stalled sinks  each of the lake's pipelines that took records in and whose sink wrote none
//   destinations   each of the lake's two OTLP destinations that is missing, disabled, or failing
//                  (its `last_error`, set while a push fails)
// The rules, the dropped rows and the stalled sinks look back LOOKBACK_MINUTES, the time since the
// run before; the rest is the account's listings now. Nothing asks whether rows arrived lately: a
// dev lake is quiet at night. One page, `telemetry`, is open while anything is red and names each finding
// (./page.ts `advance`): a finding the open page has not named escalates it. The hourly copy of the
// metrics into the lake is ./metrics-copy.ts.
import { z } from "zod";
import { CLOUDFLARE_API, fetchRetryingPlatformFailures } from "iterate/platform-retry";
import { cloudflareAccounts, telemetryEnvs } from "../../envs.ts";
import { cloudflareApi, dopplerSecret } from "../lib/env-context.ts";
import { cfGraphql } from "./do-duration-probe.ts";
import { advance, SignalMemory, type PageUpdate } from "./page.ts";

export type TelemetryEnv = (typeof telemetryEnvs)[keyof typeof telemetryEnvs];

/** HOW FAR BACK A RUN LOOKS: the health job's interval and ten minutes more, so a run that starts
 *  late leaves no minute unjudged. .depot/workflows/health.yml's cron is hourly: a longer interval
 *  there needs a longer look back here. A minute two runs both judge keeps its page open an hour
 *  longer, and nothing else. */
const LOOKBACK_MINUTES = 70;

/** What every rule's query judges: the lake's one Worker since the run before. `{worker}` is the
 *  lake's `alertRulesWorkerName` (envs.ts says why the dataset's other Workers are not judged). */
const JUDGED = `blob3 = '{worker}' AND timestamp > NOW() - INTERVAL '${LOOKBACK_MINUTES}' MINUTE`;

/** An alert rule: one flat Analytics Engine query over `iterate_metrics` (blob1…6 are name, kind,
 *  worker, project, path and labels; double1 the value; `_sample_interval` the weight), filtered by
 *  JUDGED, whose every row with a `value` over `line` is a finding, named by its other columns. */
export type AlertRule = { name: string; unit: string; line: number; sql: string };

/** The lines are first guesses, not measurements: nothing wrote these metrics before them. */
export const ALERT_RULES: AlertRule[] = [
  // Offsets, not events: the gauge is how far a subscription's cursor is behind its stream's
  // durable head, in a sequence ephemeral events take offsets from and whose events its filter may
  // skip, plus a fan-out row's deliveries not yet acked
  // (core/os/src/stream/subscription-delivery.ts): an upper bound on the events it still owes.
  {
    name: "subscription.pending",
    unit: "offsets behind",
    line: 1_000,
    sql: `SELECT blob4 AS project_id, blob5 AS path, blob6 AS labels, max(double1) AS value FROM iterate_metrics WHERE blob1 = 'subscription.pending' AND ${JUDGED} GROUP BY project_id, path, labels ORDER BY value DESC LIMIT 5`,
  },
  {
    name: "subscription.delivery_ms p99",
    unit: "ms",
    line: 60_000,
    sql: `SELECT quantileExactWeighted(0.99)(double1, _sample_interval) AS value FROM iterate_metrics WHERE blob1 = 'subscription.delivery_ms' AND ${JUDGED}`,
  },
];

/** A red condition: `key` names it for as long as it lasts (the page's failures), `text` says how
 *  bad it is now. */
export type Finding = { key: string; text: string };

const AnalyticsEngineRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
/** Analytics Engine's `FORMAT JSON` answer: a UInt64 comes as a string, a Float64 as a number. */
const AnalyticsEngineAnswer = z.object({ data: z.array(AnalyticsEngineRow) });
export type AnalyticsEngineRow = z.infer<typeof AnalyticsEngineRow>;

/** A POST to one of Cloudflare's APIs, sent again on CLOUDFLARE_API's schedule when it fails: every
 *  POST here is a read, or a send of `metrics` rows (./metrics-copy.ts), which may then land twice.
 *  Its answer's text, or a throw quoting it. */
export async function cloudflarePost(url: string, apiToken: string, body: string) {
  const response = await fetchRetryingPlatformFailures(
    `POST ${url}`,
    (signal) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body,
        signal,
      }),
    { area: "telemetry", schedule: CLOUDFLARE_API, timeoutMs: 60_000, idempotent: true },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`POST ${url} answered ${response.status}: ${text.slice(0, 500)}`);
  return text;
}

/** One Analytics Engine SQL query's rows (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/). */
export async function analyticsEngineSql(env: TelemetryEnv, apiToken: string, sql: string) {
  const answer = await cloudflarePost(
    `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/analytics_engine/sql`,
    apiToken,
    `${sql} FORMAT JSON`,
  );
  return AnalyticsEngineAnswer.parse(JSON.parse(answer)).data;
}

/** The account's Cloudflare API token (envs.ts `cloudflareAccounts`). */
export function cloudflareApiToken(env: TelemetryEnv) {
  const account = Object.values(cloudflareAccounts).find(
    ({ cloudflareAccountId }) => cloudflareAccountId === env.cloudflareAccountId,
  );
  if (!account) throw new Error(`envs.ts cloudflareAccounts has no ${env.cloudflareAccountId}`);
  return dopplerSecret(account.dopplerProject, account.dopplerConfig, "CLOUDFLARE_API_TOKEN");
}

/** The rule's findings in its query's rows. Pure. */
export function evaluateRule(rule: AlertRule, rows: AnalyticsEngineRow[]): Finding[] {
  return rows.flatMap(({ value, ...where }) => {
    const measured = Number(value);
    if (Number.isNaN(measured) || measured <= rule.line) return [];
    const at = Object.entries(where)
      .map(([column, cell]) => `${column}=${cell}`)
      .join(" ");
    const key = `${rule.name} over ${rule.line.toLocaleString("en-US")} ${rule.unit}${at ? ` at ${at}` : ""}`;
    return [{ key, text: `${key}: ${Math.round(measured).toLocaleString("en-US")}` }];
  });
}

/** The lake's four pipelines, by the names apps/telemetry/scripts/ensure-resources.ts gives them. */
const LAKE_PIPELINES = ["events", "logs", "spans", "metrics"].map(
  (table) => `telemetry_${table}_pipeline`,
);

/** A pipeline as the account's listing answers it. Cloudflare's API documents `status` as a string
 *  and no more: a pipeline that runs answered `running` on the dev account, 2026-10-01. */
type Pipeline = { id: string; name: string; status: string };

/** Each of the lake's pipelines the listing lacks, or lists as anything but running: its table gets
 *  no rows, which a quiet table alone would not tell. Pure. */
export function pipelineFindings(pipelines: Pipeline[]): Finding[] {
  return LAKE_PIPELINES.flatMap((name) => {
    const pipeline = pipelines.find((candidate) => candidate.name === name);
    if (pipeline?.status === "running") return [];
    const key = `${name} not running`;
    return [{ key, text: `${key}: ${pipeline ? pipeline.status : "missing"}` }];
  });
}

/** What each pipeline did since `$since`: the rows it dropped, by kind of error (its user errors);
 *  whether it took records in, up to `$settled`; and the records its sink wrote. */
const PIPELINE_COUNTS = `query ($accountTag: string!, $since: Time!, $settled: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { pipelinesUserErrorsAdaptiveGroups(limit: 100, filter: { datetime_geq: $since }, orderBy: [count_DESC]) { count dimensions { pipelineId errorFamily errorType } } pipelinesOperatorAdaptiveGroups(limit: 100, filter: { datetime_geq: $since, datetime_leq: $settled }) { sum { recordsIn } dimensions { pipelineId } } pipelinesSinkAdaptiveGroups(limit: 100, filter: { datetime_geq: $since }) { sum { recordsWritten } dimensions { pipelineId } } } } }`;

/** How long before the check a record must have come in to be owed a row by now: a sink writes
 *  what it took when its file rolls, every 60 s (docs/telemetry.md "Settings"). */
const SINK_SETTLE_MINUTES = 5;

/** The dropped rows in the data of Cloudflare's GraphQL answer to PIPELINE_COUNTS. */
const DroppedRows = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        pipelinesUserErrorsAdaptiveGroups: z.array(
          z.object({
            count: z.number(),
            dimensions: z.object({
              pipelineId: z.string(),
              errorFamily: z.string(),
              errorType: z.string(),
            }),
          }),
        ),
      }),
    ),
  }),
});

/** Each of the lake's pipelines and kind of error that dropped rows. `pipelines` is the account's
 *  pipeline listing: the dataset names a pipeline by its id alone, and the account's other
 *  pipelines are not the lake's. Pure. */
export function droppedRowFindings(data: unknown, pipelines: { id: string; name: string }[]) {
  const lake = new Map(
    pipelines.filter(({ name }) => LAKE_PIPELINES.includes(name)).map(({ id, name }) => [id, name]),
  );
  return DroppedRows.parse(data).viewer.accounts.flatMap((account) =>
    account.pipelinesUserErrorsAdaptiveGroups.flatMap(({ count, dimensions }): Finding[] => {
      const name = lake.get(dimensions.pipelineId);
      if (!name) return [];
      const key = `${name} dropped rows (${dimensions.errorFamily}/${dimensions.errorType})`;
      return [{ key, text: `${key}: ${count} in the last ${LOOKBACK_MINUTES} minutes` }];
    }),
  );
}

/** The records in and written in the data of Cloudflare's GraphQL answer to PIPELINE_COUNTS. */
const SinkCounts = z.object({
  viewer: z.object({
    accounts: z.array(
      z.object({
        pipelinesOperatorAdaptiveGroups: z.array(
          z.object({
            sum: z.object({ recordsIn: z.number() }),
            dimensions: z.object({ pipelineId: z.string() }),
          }),
        ),
        pipelinesSinkAdaptiveGroups: z.array(
          z.object({
            sum: z.object({ recordsWritten: z.number() }),
            dimensions: z.object({ pipelineId: z.string() }),
          }),
        ),
      }),
    ),
  }),
});

/** Each of the lake's pipelines that took records in and whose sink wrote none. A sink that cannot
 *  write (its catalog token revoked, the catalog down) drops nothing its stream reports and fails
 *  no send: its table only goes quiet. Only whether records came in is read, never how many: the
 *  dataset counts a record at each of a pipeline's stages. Pure. */
export function stalledSinkFindings(data: unknown, pipelines: { id: string; name: string }[]) {
  return SinkCounts.parse(data).viewer.accounts.flatMap((account) =>
    pipelines
      .filter(({ name }) => LAKE_PIPELINES.includes(name))
      .flatMap(({ id, name }): Finding[] => {
        const of = (group: { dimensions: { pipelineId: string } }) =>
          group.dimensions.pipelineId === id;
        const tookRecordsIn = account.pipelinesOperatorAdaptiveGroups.some(
          (group) => of(group) && group.sum.recordsIn > 0,
        );
        const wrote = account.pipelinesSinkAdaptiveGroups.some(
          (group) => of(group) && group.sum.recordsWritten > 0,
        );
        if (!tookRecordsIn || wrote) return [];
        const key = `${name}'s sink wrote nothing`;
        return [
          { key, text: `${key} of the records it took in the last ${LOOKBACK_MINUTES} minutes` },
        ];
      }),
  );
}

/** The account's OTLP destinations, as far as this reads them: a destination that has never pushed
 *  may have no status yet. */
const Destinations = z.array(
  z.object({
    slug: z.string(),
    enabled: z.boolean(),
    configuration: z.object({
      jobStatus: z
        .object({ last_error: z.string().nullish(), error_message: z.string().nullish() })
        .optional(),
    }),
  }),
);

/** Each of the lake's two destinations that exports nothing now: one the listing lacks, one
 *  disabled, or one failing (Cloudflare sets `last_error` when a push fails and clears it once one
 *  succeeds). Reads nothing else of a destination, whose headers hold its secret. Pure. */
export function destinationFindings(answer: unknown): Finding[] {
  const destinations = Destinations.parse(answer);
  return ["telemetry-traces", "telemetry-logs"].flatMap((slug) => {
    const destination = destinations.find((candidate) => candidate.slug === slug);
    if (!destination?.enabled) {
      const key = `OTLP destination ${slug} ${destination ? "disabled" : "missing"}`;
      return [{ key, text: key }];
    }
    const { jobStatus } = destination.configuration;
    if (!jobStatus?.last_error) return [];
    const key = `OTLP destination ${slug} failing`;
    return [{ key, text: `${key} since ${jobStatus.last_error}: ${jobStatus.error_message}` }];
  });
}

/** Every finding on one account now. Throws when it cannot read one of them. */
async function findingsOf(env: TelemetryEnv, now: Date) {
  const apiToken = cloudflareApiToken(env);
  const cf = cloudflareApi(apiToken);
  const account = `/accounts/${env.cloudflareAccountId}`;
  const rules = await Promise.all(
    ALERT_RULES.map(async (rule) =>
      evaluateRule(
        rule,
        await analyticsEngineSql(
          env,
          apiToken,
          rule.sql.replace("{worker}", env.alertRulesWorkerName),
        ),
      ),
    ),
  );
  const pipelines = await cf<Pipeline[]>(`${account}/pipelines/v1/pipelines?per_page=100`);
  const counts = await cfGraphql<unknown>({
    apiToken,
    query: PIPELINE_COUNTS,
    variables: {
      accountTag: env.cloudflareAccountId,
      since: new Date(now.getTime() - LOOKBACK_MINUTES * 60_000).toISOString(),
      settled: new Date(now.getTime() - SINK_SETTLE_MINUTES * 60_000).toISOString(),
    },
  });
  const destinations = await cf<unknown>(`${account}/workers/observability/destinations`);
  return [
    ...rules.flat(),
    ...pipelineFindings(pipelines),
    ...droppedRowFindings(counts, pipelines),
    ...stalledSinkFindings(counts, pipelines),
    ...destinationFindings(destinations),
  ];
}

/** The telemetry check: every account's findings, each named by its account, judged. */
export async function checkTelemetry(input: {
  memory: SignalMemory | undefined;
  testRun: boolean;
  runUrl?: string;
  now: Date;
}) {
  const findings: Finding[] = [];
  // ONE LAKE TODAY: a lake that cannot be read throws here, and the findings of the lakes read
  // before it go unpaged. A second lake gets its own signal, under its own `attempt` (./health.ts).
  for (const [name, env] of Object.entries(telemetryEnvs))
    for (const finding of await findingsOf(env, input.now))
      findings.push({ key: `${name}: ${finding.key}`, text: `${name}: ${finding.text}` });
  for (const finding of findings) console.log(`RED ${finding.text}`);
  if (findings.length === 0) console.log("every telemetry check is green");
  return judgeTelemetry({ ...input, findings });
}

/** What the findings owe the `telemetry` page, and the memory after them (./page.ts `advance`). A
 *  test run tells this run alone: a page for what is red, else the resolution. Pure. */
export function judgeTelemetry(input: {
  memory: SignalMemory | undefined;
  findings: Finding[];
  testRun: boolean;
  runUrl?: string;
  now: Date;
}): { memory: SignalMemory; update: PageUpdate | undefined } {
  const { findings } = input;
  const { memory, news, ...judged } = advance(input.testRun ? undefined : input.memory, {
    state: findings.length > 0 ? "red" : "green",
    sha: input.now.toISOString(),
    failures: findings.map((finding) => finding.key),
  });
  const action = input.testRun && !judged.action ? "resolve" : judged.action;
  const signal = "telemetry";
  if (!action) return { memory, update: undefined };
  if (action === "resolve")
    return { memory, update: { signal, kind: action, why: "every telemetry check is green" } };
  const page = {
    what: `Telemetry: ${findings.length} red`,
    impact: findings.map((finding) => finding.text).join("; "),
    action:
      "a pipeline not running, a dropped row or a destination not exporting loses telemetry until fixed: docs/telemetry.md",
    link: input.runUrl,
  };
  // red and green are this signal's only states, so `replace` (red ↔ unjudged) never comes
  const update: PageUpdate =
    action === "escalate"
      ? { signal, kind: action, page, news: `new: ${news.join("; ")}` }
      : { signal, kind: action === "edit" ? "edit" : "post", page };
  return { memory, update };
}

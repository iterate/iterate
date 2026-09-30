// scripts/monitors/telemetry.ts — THE TELEMETRY ALERTS, one check of the hourly health job
// (./health.ts), on every account envs.ts `telemetryEnvs` names (docs/telemetry.md):
//   rules          each of ALERT_RULES, one flat Analytics Engine query, against its line
//   dropped rows   Pipelines' user errors over the last hour: rows a stream accepted and dropped
//   destinations   each OTLP destination's `last_error`, set while it is failing
// One page, `telemetry`, is open while anything is red and names each finding (./page.ts
// `advance`): a finding the open page has not named escalates it. The hourly copy of the metrics
// into the lake is ./metrics-copy.ts. Every call uses the account's Cloudflare API token (envs.ts
// `cloudflareAccounts`), as the DO cost check does.
import { z } from "zod";
import { CLOUDFLARE_API, fetchRetryingPlatformFailures } from "iterate/platform-retry";
import { cloudflareAccounts, telemetryEnvs } from "../../envs.ts";
import { cloudflareApi, dopplerSecret } from "../lib/env-context.ts";
import { advance, SignalMemory, type PageUpdate } from "./page.ts";

export type TelemetryEnv = (typeof telemetryEnvs)[keyof typeof telemetryEnvs];

/** An alert rule: one flat Analytics Engine query over the metrics dataset (blob1…6 are name, kind,
 *  worker, project, path and labels; double1 the value; `_sample_interval` the weight), whose every
 *  row with a `value` over `line` is a finding, named by its other columns. */
export type AlertRule = {
  name: string;
  unit: string;
  line: number;
  sql: (dataset: string) => string;
};

/** The lines are first guesses, not measurements: nothing wrote these metrics before them. */
export const ALERT_RULES: AlertRule[] = [
  {
    name: "subscription.pending",
    unit: "events",
    line: 1_000,
    sql: (dataset) =>
      `SELECT blob4 AS project_id, blob5 AS path, blob6 AS labels, max(double1) AS value FROM ${dataset} WHERE blob1 = 'subscription.pending' AND timestamp > NOW() - INTERVAL '15' MINUTE GROUP BY project_id, path, labels ORDER BY value DESC LIMIT 5`,
  },
  {
    name: "subscription.delivery_ms p99",
    unit: "ms",
    line: 60_000,
    sql: (dataset) =>
      `SELECT quantileExactWeighted(0.99)(double1, _sample_interval) AS value FROM ${dataset} WHERE blob1 = 'subscription.delivery_ms' AND timestamp > NOW() - INTERVAL '15' MINUTE`,
  },
];

/** A red condition: `key` names it for as long as it lasts (the page's failures), `text` says how
 *  bad it is now. */
export type Finding = { key: string; text: string };

const AnalyticsEngineRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
/** Analytics Engine's `FORMAT JSON` answer: a UInt64 comes as a string, a Float64 as a number. */
const AnalyticsEngineAnswer = z.object({ data: z.array(AnalyticsEngineRow) });
export type AnalyticsEngineRow = z.infer<typeof AnalyticsEngineRow>;

/** A POST to one of Cloudflare's APIs, sent again on CLOUDFLARE_API's schedule when it failed and
 *  is `idempotent`: its answer's text, or a throw quoting it. */
export async function cloudflarePost(
  url: string,
  apiToken: string,
  body: string,
  options: { idempotent: boolean },
) {
  const response = await fetchRetryingPlatformFailures(
    `POST ${url}`,
    (signal) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body,
        signal,
      }),
    { area: "telemetry", schedule: CLOUDFLARE_API, timeoutMs: 60_000, ...options },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`POST ${url} answered ${response.status}: ${text.slice(0, 500)}`);
  return text;
}

/** One Analytics Engine SQL query's rows (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/). */
export async function analyticsEngineSql(env: TelemetryEnv, apiToken: string, sql: string) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/analytics_engine/sql`;
  return analyticsEngineRows(
    await cloudflarePost(url, apiToken, `${sql} FORMAT JSON`, { idempotent: true }),
  );
}

/** The rows of an Analytics Engine `FORMAT JSON` answer. Pure. */
export function analyticsEngineRows(answer: string) {
  return AnalyticsEngineAnswer.parse(JSON.parse(answer)).data;
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

/** Cloudflare's GraphQL answer to DROPPED_ROWS: its `errors`, or its data. */
const DroppedRows = z.union([
  z.object({ errors: z.array(z.object({ message: z.string() })).min(1) }),
  z.object({
    data: z.object({
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
    }),
  }),
]);

/** Pipelines' user errors since `$since`: the rows each pipeline dropped, by kind of error. */
const DROPPED_ROWS = `query ($accountTag: string!, $since: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { pipelinesUserErrorsAdaptiveGroups(limit: 100, filter: { datetime_geq: $since }, orderBy: [count_DESC]) { count dimensions { pipelineId errorFamily errorType } } } } }`;

/** Each pipeline and kind of error that dropped rows in the GraphQL answer. Pure. */
export function droppedRowFindings(answer: unknown, pipelineNames: Map<string, string>) {
  const parsed = DroppedRows.parse(answer);
  if ("errors" in parsed)
    throw new Error(
      `Cloudflare GraphQL: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  return parsed.data.viewer.accounts.flatMap((account) =>
    account.pipelinesUserErrorsAdaptiveGroups.map(({ count, dimensions }): Finding => {
      const key = `${pipelineNames.get(dimensions.pipelineId) || dimensions.pipelineId} dropped rows (${dimensions.errorFamily}/${dimensions.errorType})`;
      return { key, text: `${key}: ${count} in the last hour` };
    }),
  );
}

const Destinations = z.array(
  z.object({
    slug: z.string(),
    configuration: z.object({
      jobStatus: z.object({ last_error: z.string(), error_message: z.string() }),
    }),
  }),
);

/** Each destination failing now: Cloudflare sets `last_error` when a push fails and clears it once
 *  one succeeds. Reads nothing else of a destination, whose headers hold its secret. Pure. */
export function destinationFindings(answer: unknown): Finding[] {
  return Destinations.parse(answer).flatMap(({ slug, configuration: { jobStatus } }) => {
    if (!jobStatus.last_error) return [];
    const key = `OTLP destination ${slug} failing`;
    return [{ key, text: `${key} since ${jobStatus.last_error}: ${jobStatus.error_message}` }];
  });
}

/** The account's Cloudflare API token, as the DO cost check reads it. */
export function telemetryApiToken(env: TelemetryEnv) {
  const account = Object.values(cloudflareAccounts).find(
    (candidate) => candidate.cloudflareAccountId === env.cloudflareAccountId,
  );
  if (!account) throw new Error(`envs.ts cloudflareAccounts has no ${env.cloudflareAccountId}`);
  return dopplerSecret(account.dopplerProject, account.dopplerConfig, "CLOUDFLARE_API_TOKEN");
}

/** Every finding on one account now. Throws when it cannot read one of them. */
async function findingsOf(env: TelemetryEnv, now: Date) {
  const apiToken = telemetryApiToken(env);
  const cf = cloudflareApi(apiToken);
  const account = `/accounts/${env.cloudflareAccountId}`;
  const ruleFindings = await Promise.all(
    ALERT_RULES.map(async (rule) =>
      evaluateRule(rule, await analyticsEngineSql(env, apiToken, rule.sql(env.metricsDataset))),
    ),
  );
  const pipelines = await cf<{ id: string; name: string }[]>(
    `${account}/pipelines/v1/pipelines?per_page=100`,
  );
  const dropped = await cloudflarePost(
    "https://api.cloudflare.com/client/v4/graphql",
    apiToken,
    JSON.stringify({
      query: DROPPED_ROWS,
      variables: {
        accountTag: env.cloudflareAccountId,
        since: new Date(now.getTime() - 3_600_000).toISOString(),
      },
    }),
    { idempotent: true },
  );
  const destinations = await cf<unknown>(`${account}/workers/observability/destinations`);
  return [
    ...ruleFindings.flat(),
    ...droppedRowFindings(
      JSON.parse(dropped),
      new Map(pipelines.map(({ id, name }) => [id, name])),
    ),
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
  for (const [name, env] of Object.entries(telemetryEnvs))
    for (const finding of await findingsOf(env, input.now))
      findings.push({ key: `${name}: ${finding.key}`, text: `${name}: ${finding.text}` });
  for (const finding of findings) console.log(`RED ${finding.text}`);
  if (findings.length === 0) console.log("every telemetry rule is under its line");
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
  const signal = "telemetry";
  const judged = advance(input.testRun ? undefined : input.memory, {
    state: findings.length > 0 ? "red" : "green",
    sha: input.now.toISOString(),
    failures: findings.map((finding) => finding.key),
  });
  const { memory } = judged;
  const action = input.testRun && !judged.action ? "resolve" : judged.action;
  if (!action) return { memory, update: undefined };
  if (action === "resolve")
    return {
      memory,
      update: { signal, kind: "resolve", why: "every telemetry rule is back under its line" },
    };
  const page = {
    what: `Telemetry: ${findings.length} red`,
    impact: findings.map((finding) => finding.text).join("; "),
    action: "a dropped row or a failing destination loses telemetry until fixed: docs/telemetry.md",
    link: input.runUrl,
  };
  if (action === "escalate")
    return {
      memory,
      update: {
        signal,
        kind: "escalate",
        page,
        news: `new: ${judged.news.join("; ")}`,
        broadcast: false,
      },
    };
  // red and green are this signal's only states, so `replace` (red ↔ unjudged) never comes
  return { memory, update: { signal, kind: action === "edit" ? "edit" : "post", page } };
}

// The telemetry alerts' decisions: each rule against Analytics Engine rows as its SQL API writes
// them, the lake's pipelines, their dropped rows and its destinations as Cloudflare answers them,
// and what the findings owe the page. The calls themselves are proven against the dev account.
import { expect, test } from "vitest";
import { osEnvs, telemetryEnvs } from "../../envs.ts";
import {
  ALERT_RULES,
  destinationFindings,
  droppedRowFindings,
  evaluateRule,
  judgeTelemetry,
  pipelineFindings,
  stalledSinkFindings,
  type AnalyticsEngineRow,
  type Finding,
} from "./telemetry.ts";

const [pending, deliveryP99] = ALERT_RULES;

test("the dev lake's rules judge main on dev: renamed, they would judge nothing and stay green", () => {
  expect(telemetryEnvs.preview).toMatchObject({
    alertRulesWorkerName: osEnvs.preview!.workerName,
  });
});

test.for<{
  name: string;
  rule: (typeof ALERT_RULES)[number];
  rows: AnalyticsEngineRow[];
  findings: Finding[];
}>([
  {
    name: "a row whose pending max is over the line is a finding named by its context and row",
    rule: pending!,
    rows: [
      { project_id: "prj_a", path: "/agents/x", labels: "row=config", value: 2400 },
      { project_id: "prj_b", path: "/", labels: "row=agent", value: 12 },
    ],
    findings: [
      {
        key: "subscription.pending over 1,000 offsets behind at project_id=prj_a path=/agents/x labels=row=config",
        text: "subscription.pending over 1,000 offsets behind at project_id=prj_a path=/agents/x labels=row=config: 2,400",
      },
    ],
  },
  {
    name: "rows at or under the line are no finding",
    rule: pending!,
    rows: [{ project_id: "prj_a", path: "/", labels: "row=config", value: 1000 }],
    findings: [],
  },
  {
    name: "a p99 over the line is one finding with no context",
    rule: deliveryP99!,
    rows: [{ value: 75321.4 }],
    findings: [
      {
        key: "subscription.delivery_ms p99 over 60,000 ms",
        text: "subscription.delivery_ms p99 over 60,000 ms: 75,321",
      },
    ],
  },
  {
    name: "a p99 over no points is 0, no finding",
    rule: deliveryP99!,
    rows: [{ value: 0 }],
    findings: [],
  },
  {
    name: "a UInt64 value, which the SQL API writes as a string, is compared as a number",
    rule: pending!,
    rows: [{ project_id: "prj_a", path: "/", labels: "row=config", value: "1500" }],
    findings: [
      {
        key: "subscription.pending over 1,000 offsets behind at project_id=prj_a path=/ labels=row=config",
        text: "subscription.pending over 1,000 offsets behind at project_id=prj_a path=/ labels=row=config: 1,500",
      },
    ],
  },
])("$name", ({ rule, rows, findings }) => {
  expect(evaluateRule(rule, rows)).toEqual(findings);
});

test("every rule judges the lake's one Worker alone: the dataset's others are previews under test", () => {
  // exact: no rule lacks the filter
  expect(ALERT_RULES.filter((rule) => !rule.sql.includes("blob3 = '{worker}'"))).toEqual([]);
});

test.for<{ name: string; pipelines: Parameters<typeof pipelineFindings>[0]; findings: Finding[] }>([
  {
    name: "the lake's four pipelines running is no finding, whatever the account's others do",
    pipelines: [
      pipeline("events"),
      pipeline("logs"),
      pipeline("spans"),
      pipeline("metrics"),
      pipeline("spike_logs", "failed"),
    ],
    findings: [],
  },
  {
    name: "a pipeline the account does not list is a finding",
    pipelines: [pipeline("events"), pipeline("spans"), pipeline("metrics")],
    findings: [
      {
        key: "telemetry_logs_pipeline not running",
        text: "telemetry_logs_pipeline not running: missing",
      },
    ],
  },
  {
    name: "a pipeline in any status but running is a finding that says the status",
    pipelines: [
      pipeline("events"),
      pipeline("logs"),
      pipeline("spans", "failed"),
      pipeline("metrics"),
    ],
    findings: [
      {
        key: "telemetry_spans_pipeline not running",
        text: "telemetry_spans_pipeline not running: failed",
      },
    ],
  },
])("pipelines: $name", ({ pipelines, findings }) => {
  expect(pipelineFindings(pipelines)).toEqual(findings);
});

test.for<{ name: string; groups: unknown[]; findings: Finding[] }>([
  { name: "no user errors is no finding", groups: [], findings: [] },
  {
    name: "each of the lake's pipelines and kind of error is a finding, named by the pipeline",
    groups: [
      group({ pipelineId: "1a37", errorFamily: "deserialization", errorType: "missing_field" }),
      group({ pipelineId: "1a37", errorFamily: "sink", errorType: "write" }),
    ],
    findings: [
      {
        key: "telemetry_metrics_pipeline dropped rows (deserialization/missing_field)",
        text: "telemetry_metrics_pipeline dropped rows (deserialization/missing_field): 4 in the last 70 minutes",
      },
      {
        key: "telemetry_metrics_pipeline dropped rows (sink/write)",
        text: "telemetry_metrics_pipeline dropped rows (sink/write): 4 in the last 70 minutes",
      },
    ],
  },
  {
    name: "another pipeline on the account, or one no longer listed, is not the lake's",
    groups: [group({ pipelineId: "e6b2" }), group({ pipelineId: "ffff" })],
    findings: [],
  },
])("dropped rows: $name", ({ groups, findings }) => {
  const data = { viewer: { accounts: [{ pipelinesUserErrorsAdaptiveGroups: groups }] } };
  const pipelines = [
    { id: "1a37", name: "telemetry_metrics_pipeline" },
    { id: "e6b2", name: "telemetry_spike_logs_pipeline" },
  ];
  expect(droppedRowFindings(data, pipelines)).toEqual(findings);
});

// What each pipeline took in and what its sink wrote, as [pipelineId, records] pairs.
test.for<{
  name: string;
  taken: [string, number][];
  written: [string, number][];
  findings: Finding[];
}>([
  {
    name: "a quiet lake, nothing in and nothing written, is no finding",
    taken: [],
    written: [],
    findings: [],
  },
  {
    name: "a pipeline that took records in and wrote some is no finding",
    taken: [["1a37", 9_000]],
    written: [["1a37", 3_000]],
    findings: [],
  },
  {
    name: "a pipeline that took records in and whose sink wrote none is a finding",
    taken: [["1a37", 9_000]],
    written: [["1a37", 0]],
    findings: [
      {
        key: "telemetry_metrics_pipeline's sink wrote nothing",
        text: "telemetry_metrics_pipeline's sink wrote nothing of the records it took in the last 70 minutes",
      },
    ],
  },
  {
    name: "a sink the dataset does not list at all wrote none",
    taken: [["1a37", 12]],
    written: [],
    findings: [
      {
        key: "telemetry_metrics_pipeline's sink wrote nothing",
        text: "telemetry_metrics_pipeline's sink wrote nothing of the records it took in the last 70 minutes",
      },
    ],
  },
  {
    name: "another pipeline on the account is not the lake's",
    taken: [["e6b2", 500]],
    written: [],
    findings: [],
  },
])("stalled sinks: $name", ({ taken, written, findings }) => {
  const data = {
    viewer: {
      accounts: [
        {
          pipelinesOperatorAdaptiveGroups: taken.map(([pipelineId, recordsIn]) => ({
            sum: { recordsIn },
            dimensions: { pipelineId },
          })),
          pipelinesSinkAdaptiveGroups: written.map(([pipelineId, recordsWritten]) => ({
            sum: { recordsWritten },
            dimensions: { pipelineId },
          })),
        },
      ],
    },
  };
  const pipelines = [
    { id: "1a37", name: "telemetry_metrics_pipeline" },
    { id: "e6b2", name: "telemetry_spike_logs_pipeline" },
  ];
  expect(stalledSinkFindings(data, pipelines)).toEqual(findings);
});

test.for<{ name: string; destinations: unknown[]; findings: Finding[] }>([
  {
    name: "both destinations enabled, their last push a success, is no finding",
    destinations: [destination("telemetry-traces"), destination("telemetry-logs")],
    findings: [],
  },
  {
    name: "a destination with a last_error is failing now",
    destinations: [
      destination("telemetry-traces"),
      destination("telemetry-logs", { lastError: "2026-09-30T13:16:09Z" }),
    ],
    findings: [
      {
        key: "OTLP destination telemetry-logs failing",
        text: "OTLP destination telemetry-logs failing since 2026-09-30T13:16:09Z: error 503: error pushing",
      },
    ],
  },
  {
    name: "another destination on the account is not the lake's, failing or not",
    destinations: [
      destination("telemetry-traces"),
      destination("telemetry-logs"),
      destination("telemetry-spike-traces", { lastError: "2026-09-30T13:16:09Z" }),
    ],
    findings: [],
  },
  {
    name: "a destination with no status yet has not failed",
    destinations: [
      { slug: "telemetry-traces", enabled: true, configuration: { type: "logpush" } },
      destination("telemetry-logs"),
    ],
    findings: [],
  },
  {
    name: "a disabled destination is a finding, whatever its last push",
    destinations: [
      destination("telemetry-traces", { enabled: false }),
      destination("telemetry-logs"),
    ],
    findings: [
      {
        key: "OTLP destination telemetry-traces disabled",
        text: "OTLP destination telemetry-traces disabled",
      },
    ],
  },
  {
    name: "a destination the account does not list is a finding",
    destinations: [destination("telemetry-traces")],
    findings: [
      {
        key: "OTLP destination telemetry-logs missing",
        text: "OTLP destination telemetry-logs missing",
      },
    ],
  },
])("destinations: $name", ({ destinations, findings }) => {
  expect(destinationFindings(destinations)).toEqual(findings);
});

const red = { key: "preview: a over 1", text: "preview: a over 1: 5" };
const redToo = { key: "preview: b over 1", text: "preview: b over 1: 9" };
const redMemory = {
  state: "red" as const,
  since: "2026-09-30T12:41:00.000Z",
  runs: 1,
  failures: [red.key],
};

test.for<{
  name: string;
  memory: Parameters<typeof judgeTelemetry>[0]["memory"];
  findings: Finding[];
  testRun?: boolean;
  update: unknown;
}>([
  { name: "green after green pages nothing", memory: undefined, findings: [], update: undefined },
  {
    name: "red after green posts a page naming each finding",
    memory: { state: "green" },
    findings: [red],
    update: { kind: "post", page: { what: "Telemetry: 1 red", impact: red.text } },
  },
  {
    name: "the same finding again edits the page",
    memory: redMemory,
    findings: [red],
    update: { kind: "edit", page: { impact: red.text } },
  },
  {
    name: "a finding the page has not named escalates it",
    memory: redMemory,
    findings: [red, redToo],
    update: { kind: "escalate", news: `new: ${redToo.key}` },
  },
  {
    name: "green after red resolves the page",
    memory: redMemory,
    findings: [],
    update: { kind: "resolve" },
  },
  {
    name: "a test run with nothing red posts the resolution, whatever the memory",
    memory: undefined,
    findings: [],
    testRun: true,
    update: { kind: "resolve" },
  },
])("page: $name", ({ memory, findings, testRun = false, update }) => {
  const judged = judgeTelemetry({
    memory,
    findings,
    testRun,
    now: new Date("2026-09-30T13:41:00Z"),
  });
  expect({ update: judged.update }).toMatchObject({ update });
});

/** One of the account's pipelines as its listing answers it, named as ensure-resources names a
 *  table's. */
function pipeline(table: string, status = "running") {
  return { id: table, name: `telemetry_${table}_pipeline`, status };
}

/** One group of Pipelines' user errors as the GraphQL dataset answers it. */
function group(dimensions: { pipelineId: string; errorFamily?: string; errorType?: string }) {
  return { count: 4, dimensions: { errorFamily: "sink", errorType: "write", ...dimensions } };
}

/** One destination as the list answers it, recorded on the dev account 2026-09-30, its headers'
 *  secret replaced. */
function destination(slug: string, fields: { enabled?: boolean; lastError?: string } = {}) {
  const { enabled = true, lastError = "" } = fields;
  return {
    slug,
    enabled,
    configuration: {
      type: "logpush",
      headers: { "x-telemetry-secret": "redacted" },
      jobStatus: {
        last_complete: "2026-09-30T13:09:46Z",
        last_error: lastError,
        error_message: lastError ? "error 503: error pushing" : "",
      },
    },
  };
}

// Cloudflare's OTLP export flattened into `logs` and `spans` rows (otlp.ts), and each row checked
// against its stream's schema (stream-schema.test-support.ts). The fixtures are Cloudflare's
// exports of telemetry-spike-producer on the dev account on 2026-09-30, cut to a few records, with
// the requester's ASN replaced by a documentation one. Three edits add what that Worker never
// wrote: in logs.json one object line's `msg` is `event`, its `project` is `projectId` beside a
// `path`, and its int is OTLP JSON's string form; in traces.json the Durable Object's span carries
// `iterate.project_id` and `iterate.path`.
import { expect, test } from "vitest";
import logsSchema from "../schemas/logs.json" with { type: "json" };
import spansSchema from "../schemas/spans.json" with { type: "json" };
import logs from "./fixtures/logs.json" with { type: "json" };
import preflightLogs from "./fixtures/preflight-logs.json" with { type: "json" };
import preflightTraces from "./fixtures/preflight-traces.json" with { type: "json" };
import traces from "./fixtures/traces.json" with { type: "json" };
import { logRows, OtlpLogs, OtlpTraces, spanRows } from "./otlp.ts";
import { rowProblems } from "./stream-schema.test-support.ts";

const producer = { worker: "telemetry-spike-producer" };
const run2 = { ...producer, version: "a339ac78-1d12-4f32-9645-6e65199c5be2" };
const crash = {
  ...producer,
  version: "ea4ed790-bb4e-4a0f-9c8f-30328336f811",
  trace_id: "f48ec96b8d15525c1dbf684f84247360",
};
/** The resource of oneLine's line and oneSpan's span. */
const resource = {
  attributes: [
    { key: "cloudflare.script_name", value: { stringValue: "telemetry-spike-producer" } },
  ],
};
/** oneSpan's span as a row. */
const oneSpanRow = {
  ...producer,
  time: "2026-09-30T13:03:12.219Z",
  trace_id: "6856a5e381eb349528cb7f1a43d05802",
  span_id: "24ecca8e68383c93",
  name: "GET",
  duration_ms: 0,
  attributes: "{}",
  attributes_bytes: 2,
};

test.for([
  {
    name: "the destination's preflight lands no rows",
    rows: [...logsOf(preflightLogs), ...spansOf(preflightTraces)],
    expected: [],
  },
  {
    name: "console lines and exceptions are log rows; Cloudflare's per-request records are dropped",
    rows: logsOf(logs),
    expected: [
      {
        ...crash,
        time: "2026-09-30T13:24:57.705Z",
        level: "info",
        span_id: "946881827bbbdf68",
        seq: 1,
        body: JSON.stringify({ msg: "about to crash", marker: "crash-16" }),
        body_bytes: 44,
      },
      {
        ...crash,
        time: "2026-09-30T13:24:57.705Z",
        level: "error",
        span_id: "946881827bbbdf68",
        seq: 2,
        body: "producer crash crash-16",
        body_bytes: 23,
        exception: "Error: producer crash crash-16",
        stack: "    at Object.fetch (index.js:80:13)",
      },
      {
        ...run2,
        time: "2026-09-30T13:03:12.219Z",
        project_id: "prj_spike",
        path: "/agents/web/spike",
        level: "info",
        trace_id: "3b5c20eecb4bbde12809b1edebca6b35",
        span_id: "ab0ba7257f893245",
        seq: 1,
        event: "producer.fetch",
        body: JSON.stringify({
          event: "producer.fetch",
          marker: "run2-3",
          projectId: "prj_spike",
          path: "/agents/web/spike",
          nested: { a: 1, list: [1, "two", { three: 3 }] },
          n: 42,
          flag: true,
          nothing: null,
        }),
        body_bytes: 175,
      },
      {
        ...run2,
        time: "2026-09-30T13:03:12.219Z",
        level: "info",
        trace_id: "3b5c20eecb4bbde12809b1edebca6b35",
        span_id: "ab0ba7257f893245",
        seq: 2,
        body: "producer plain string run2-3",
        body_bytes: 28,
      },
      {
        ...run2,
        time: "2026-09-30T13:03:12.219Z",
        level: "warn",
        trace_id: "3b5c20eecb4bbde12809b1edebca6b35",
        span_id: "ab0ba7257f893245",
        seq: 3,
        body: JSON.stringify({ msg: "producer.warn", marker: "run2-3" }),
        body_bytes: 41,
      },
      {
        ...run2,
        time: "2026-09-30T13:03:12.060Z",
        level: "error",
        trace_id: "eaa416fc30ce6e27406aed948320e968",
        span_id: "1b4f6d4e620888d8",
        seq: 4,
        body: JSON.stringify({
          msg: "dyn threw",
          marker: "run2-2",
          error: "Error: dyn boom run2-2",
        }),
        body_bytes: 70,
      },
    ],
  },
  {
    name: "spans keep their columns and lose the resource, geography, user agent, headers and query",
    rows: spansOf(traces),
    expected: [
      {
        ...crash,
        time: "2026-09-30T13:24:57.686Z",
        span_id: "946881827bbbdf68",
        seq: 1,
        name: "GET",
        kind: "server",
        duration_ms: 19,
        cpu_ms: 1,
        wall_ms: 2,
        outcome: "exception",
        http_status: 500,
        url_path: "/crash",
        exception: "Error: producer crash crash-16",
        attributes: JSON.stringify({
          "cloudflare.execution_model": "stateless",
          "cloudflare.handler_type": "fetch",
          "faas.invocation_id": "6f0e1b7f37245f2a9334ee564c4d1749",
          "cloudflare.ray_id": "a4338d04285dc51c",
          "faas.trigger": "http",
          "http.request.method": "GET",
          "cloudflare.verified_bot_category": "",
          "server.port": "",
          "server.address": "telemetry-spike-producer.iterate-dev-preview.workers.dev",
          "url.scheme": "https",
          "network.protocol.name": "https",
          "cloudflare.response.time_to_first_byte_ms": 19,
        }),
        attributes_bytes: 452,
      },
      {
        ...run2,
        time: "2026-09-30T13:02:46.612Z",
        trace_id: "6856a5e381eb349528cb7f1a43d05802",
        span_id: "24ecca8e68383c93",
        parent_span_id: "2a6bbb744f907ed5",
        seq: 4,
        name: "jsRpcCall",
        kind: "client",
        duration_ms: 212.999998,
        rpc_method: "many",
        attributes: JSON.stringify({ "jsrpc.target_kind": "fetcher", "jsrpc.operation": "call" }),
        attributes_bytes: 56,
      },
      {
        ...run2,
        time: "2026-09-30T13:02:46.815Z",
        project_id: "prj_spike",
        path: "/agents/web/spike",
        trace_id: "6856a5e381eb349528cb7f1a43d05802",
        span_id: "d5b70df1fe520a24",
        parent_span_id: "24ecca8e68383c93",
        seq: 1,
        name: "jsrpc",
        kind: "server",
        duration_ms: 2,
        cpu_ms: 4,
        wall_ms: 13,
        outcome: "ok",
        entrypoint: "SpikeDO",
        object_id: "f1915ced7778f63ddc6f71c626344e02f5f8feaa1a978e4c5331966c0bcb06aa",
        rpc_method: "many",
        attributes: JSON.stringify({
          "cloudflare.execution_model": "durableObject",
          "cloudflare.handler_type": "jsrpc",
          "faas.invocation_id": "9e587341d6744bc91a302006863bdf20",
          "cloudflare.ray_id": "a4336c84b8e89503",
          "faas.trigger": "jsrpc",
        }),
        attributes_bytes: 198,
      },
      {
        ...run2,
        time: "2026-09-30T13:03:11.774Z",
        trace_id: "7ab858c2876449612d99a87ec1e9c349",
        span_id: "a9a62d8fe0c3f156",
        parent_span_id: "daae73018eee76df",
        seq: 3,
        name: "durable_object_storage_get",
        kind: "client",
        duration_ms: 0,
        entrypoint: "SpikeDO",
        object_id: "5827984be1809baab53f34f8d04a14448cd5b9cebfaaf516610f20fe6b138f40",
        attributes: "{}",
        attributes_bytes: 2,
      },
      {
        ...run2,
        time: "2026-09-30T13:03:12.017Z",
        trace_id: "eaa416fc30ce6e27406aed948320e968",
        span_id: "939702851ab71ffa",
        parent_span_id: "1b4f6d4e620888d8",
        seq: 5,
        name: "fetch",
        kind: "client",
        duration_ms: 43,
        url_path: "/",
        attributes: JSON.stringify({
          "network.protocol.name": "http",
          "network.protocol.version": "HTTP/1.1",
          "http.request.method": "GET",
          "url.scheme": "https",
          "server.port": "",
          "server.address": "dyn.example",
        }),
        attributes_bytes: 167,
      },
    ],
  },
  {
    name: "a body's falsy values stay what they were",
    rows: logsOf(
      oneLine({
        body: {
          kvlistValue: {
            values: [
              { key: "empty", value: { stringValue: "" } },
              { key: "no", value: { boolValue: false } },
              { key: "zero", value: { intValue: "0" } },
            ],
          },
        },
      }),
    ),
    expected: [
      {
        ...producer,
        time: "2026-09-30T13:03:12.219Z",
        level: "info",
        body: JSON.stringify({ empty: "", no: false, zero: 0 }),
        body_bytes: 32,
      },
    ],
  },
  {
    name: "a JSON column over 512 KB is cut there and keeps its whole size",
    rows: logsOf(oneLine({ body: { stringValue: "x".repeat(600_000) } })),
    expected: [
      {
        ...producer,
        time: "2026-09-30T13:03:12.219Z",
        level: "info",
        body: "x".repeat(512 * 1024),
        body_bytes: 600_000,
      },
    ],
  },
  {
    name: "a line's time, severity and body left out are at OTLP's defaults",
    rows: logsOf(oneLine({ timeUnixNano: undefined, severityNumber: undefined })),
    expected: [
      {
        ...producer,
        time: "1970-01-01T00:00:00.000Z",
        level: "debug",
        body: "null",
        body_bytes: 4,
      },
    ],
  },
  {
    name: "a span's kind left out is unspecified, and one past OTLP's kinds is its number",
    rows: [...spansOf(oneSpan({})), ...spansOf(oneSpan({ kind: 9 }))],
    expected: [
      { ...oneSpanRow, kind: "unspecified" },
      { ...oneSpanRow, kind: "9" },
    ],
  },
])("$name", ({ rows, expected }) => {
  // exact: a row is what lands in the table, and an extra column would fail its stream
  expect(rows).toEqual(expected);
});

test("every row of the fixtures and of OTLP's defaults fits its stream's schema", () => {
  const atDefaults = { timeUnixNano: undefined, severityNumber: undefined };
  expect({
    logs: [...logsOf(logs), ...logsOf(oneLine(atDefaults))].flatMap((row) =>
      rowProblems(logsSchema, row),
    ),
    spans: [...spansOf(traces), ...spansOf(oneSpan({}))].flatMap((row) =>
      rowProblems(spansSchema, row),
    ),
  }).toEqual({ logs: [], spans: [] });
});

test("a row that does not fit its stream's schema says why, column by column", () => {
  expect(
    rowProblems(logsSchema, { time: "yesterday", worker: 1, seq: 2 ** 31, colour: "red" }),
  ).toEqual([
    "colour: no such column",
    'time: "yesterday" is no timestamp',
    "worker: 1 is no string",
    "level: missing",
    "seq: 2147483648 is no int32",
    "body: missing",
    "body_bytes: missing",
  ]);
});

function logsOf(payload: unknown) {
  return logRows(OtlpLogs.parse(payload));
}

function spansOf(payload: unknown) {
  return spanRows(OtlpTraces.parse(payload));
}

/** One `console.log` line, as Cloudflare exports it, with `record`'s fields over its own. */
function oneLine(record: object) {
  const line = {
    timeUnixNano: "1790773392219000000",
    severityNumber: 9,
    attributes: [{ key: "name", value: { stringValue: "log" } }],
    ...record,
  };
  return { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [line] }] }] };
}

/** One span with no attributes, with `span`'s fields over its own. */
function oneSpan(span: object) {
  const own = {
    traceId: "6856a5e381eb349528cb7f1a43d05802",
    spanId: "24ecca8e68383c93",
    name: "GET",
    startTimeUnixNano: "1790773392219000000",
    endTimeUnixNano: "1790773392219000000",
    ...span,
  };
  return { resourceSpans: [{ resource, scopeSpans: [{ spans: [own] }] }] };
}

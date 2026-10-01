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
/** The resource of `lines`' lines and `spans`' spans. */
const resource = {
  attributes: [
    { key: "cloudflare.script_name", value: { stringValue: "telemetry-spike-producer" } },
  ],
};
/** A span of `spans` as a row. */
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
    name: "console lines, exceptions and Cloudflare's own record of each invocation are log rows",
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
        ...crash,
        time: "2026-09-30T13:24:57.705Z",
        level: "info",
        span_id: "946881827bbbdf68",
        seq: 3,
        event: "invocation",
        body: invocationBody({
          path: "/crash",
          query: "m=crash-16",
          status: 500,
          invocation: "6f0e1b7f37245f2a9334ee564c4d1749",
          ray: "a4338d04285dc51c",
          seq: 3,
        }),
        body_bytes: 1025,
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
        time: "2026-09-30T13:03:12.273Z",
        level: "info",
        trace_id: "3b5c20eecb4bbde12809b1edebca6b35",
        span_id: "ab0ba7257f893245",
        seq: 4,
        event: "invocation",
        body: invocationBody({
          path: "/",
          query: "m=run2-3&throw=0&do=b",
          status: 200,
          invocation: "b1542b86ba05bdd638554fdadbf8fa97",
          ray: "a4336d24da26c028",
          seq: 4,
        }),
        body_bytes: 1043,
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
      lines({
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
    name: "a JSON column over 512 KB is cut to fit, whole characters only, and keeps its whole size",
    // 600,004 bytes, scaled to a cut that ends inside a pair: the half character goes
    rows: logsOf(lines({ body: { stringValue: "😀".repeat(150_001) } })),
    expected: [
      {
        ...producer,
        time: "2026-09-30T13:03:12.219Z",
        level: "info",
        body: "😀".repeat(131_071),
        body_bytes: 600_004,
      },
    ],
  },
  {
    name: "a line's time, severity and body left out are at OTLP's defaults",
    rows: logsOf(lines({ timeUnixNano: undefined, severityNumber: undefined })),
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
    rows: spansOf(spans({}, { kind: 9 })),
    expected: [
      { ...oneSpanRow, kind: "unspecified" },
      { ...oneSpanRow, kind: "9" },
    ],
  },
])("$name", ({ rows, expected }) => {
  // exact: a row is what lands in the table, and an extra column would fail its stream
  expect(rows).toEqual(expected);
});

// A stream fails a whole send for one row over 1 MB (1,048,576 bytes) of JSON, where a control
// character takes six bytes and a quote two. `json` is the row's bytes as a stream receives it.
test.for([
  {
    name: "a body of control characters",
    rows: logsOf(lines({ body: { stringValue: "\u0000".repeat(512 * 1024) } })),
    expected: [{ kept: 87_381, whole: 524_288, json: 524_402 }],
  },
  {
    name: "a body of quotes",
    rows: logsOf(lines({ body: { stringValue: '"'.repeat(400_000) } })),
    expected: [{ kept: 262_143, whole: 400_000, json: 524_402 }],
  },
  {
    name: "an object body, whose JSON is escaped again inside the row's",
    rows: logsOf(
      lines({
        body: {
          kvlistValue: { values: [{ key: "said", value: { stringValue: '"'.repeat(300_000) } }] },
        },
      }),
    ),
    expected: [{ kept: 262_145, whole: 600_011, json: 524_400 }],
  },
  {
    name: "an uncaught exception's megabyte of message and of stack",
    rows: logsOf(
      lines({
        body: { stringValue: "m".repeat(1_000_000) },
        attributes: exceptionAttributes("m".repeat(1_000_000), "\n".repeat(1_000_000)),
      }),
    ),
    expected: [{ kept: 524_286, whole: 1_000_000, exception: 16_382, stack: 8_191, json: 557_193 }],
  },
  {
    name: "a span's attributes and its exception event",
    rows: spansOf(
      spans({
        attributes: [{ key: "windows.path", value: { stringValue: "\\".repeat(1_000_000) } }],
        events: [{ name: "exception", attributes: exceptionAttributes('"'.repeat(1_000_000), "") }],
      }),
    ),
    expected: [{ kept: 262_147, whole: 2_000_019, exception: 8_193, json: 540_913 }],
  },
])("$name is cut until its row fits a stream", ({ rows, expected }) => {
  // exact: `json` is what the cut is for
  expect(rows.map(sizes)).toEqual(expected);
});

test.for([
  {
    name: "a line whose time is no number is skipped, and the lines around it land",
    batch: logRows(
      OtlpLogs.parse(
        lines(
          { body: { stringValue: "before" } },
          { timeUnixNano: "yesterday" },
          { body: { stringValue: "after" } },
        ),
      ),
    ),
    expected: {
      rows: [{ body: "before" }, { body: "after" }],
      skipped: [expect.stringContaining("timeUnixNano")],
    },
  },
  {
    name: "a line whose time is past any date, and one that is no record, are skipped",
    batch: logRows(OtlpLogs.parse(lines({ timeUnixNano: "9".repeat(21) }, "a line"))),
    expected: { rows: [], skipped: [expect.stringContaining("timeUnixNano"), expect.any(String)] },
  },
  {
    name: "a span with no name or no end is skipped, and the span beside it lands",
    batch: spanRows(
      OtlpTraces.parse(
        spans({ name: undefined }, { spanId: "kept" }, { endTimeUnixNano: undefined }),
      ),
    ),
    expected: {
      rows: [{ span_id: "kept" }],
      skipped: [expect.stringContaining("name"), expect.stringContaining("endTimeUnixNano")],
    },
  },
  {
    name: "a resource left out is no Worker's: its records land no rows",
    batch: logRows(OtlpLogs.parse({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] })),
    expected: { rows: [], skipped: [] },
  },
])("$name", ({ batch, expected }) => {
  expect(batch).toMatchObject(expected);
});

// A body without a batch's lists is no batch: parsed as an empty one, an export whose format
// changed would be answered 200 and land nothing, and nothing would say so.
test.for([
  { name: "nothing", schema: OtlpTraces, body: {} },
  { name: "a batch of spans, for logs", schema: OtlpLogs, body: { resourceSpans: [] } },
  { name: "a resource with no scopes", schema: OtlpLogs, body: { resourceLogs: [{ resource }] } },
  {
    name: "a scope whose records go by another name",
    schema: OtlpLogs,
    body: { resourceLogs: [{ resource, scopeLogs: [{ log_records: [] }] }] },
  },
  {
    name: "a scope with no spans",
    schema: OtlpTraces,
    body: { resourceSpans: [{ resource, scopeSpans: [{}] }] },
  },
])("$name is no batch", ({ schema, body }) => {
  expect(schema.safeParse(body)).toMatchObject({ success: false });
});

test("every row of the fixtures and of OTLP's defaults fits its stream's schema", () => {
  const atDefaults = { timeUnixNano: undefined, severityNumber: undefined };
  expect({
    logs: [...logsOf(logs), ...logsOf(lines(atDefaults))].flatMap((row) =>
      rowProblems(logsSchema, row),
    ),
    spans: [...spansOf(traces), ...spansOf(spans({}))].flatMap((row) =>
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
  return logRows(OtlpLogs.parse(payload)).rows;
}

function spansOf(payload: unknown) {
  return spanRows(OtlpTraces.parse(payload)).rows;
}

/** A batch of `console.log` lines, as Cloudflare exports them, each with a record's fields over
 *  its own; a record that is no object goes in as it is. */
function lines(...records: unknown[]) {
  const logRecords = records.map((record) =>
    record instanceof Object
      ? {
          timeUnixNano: "1790773392219000000",
          severityNumber: 9,
          attributes: [{ key: "name", value: { stringValue: "log" } }],
          ...record,
        }
      : record,
  );
  return { resourceLogs: [{ resource, scopeLogs: [{ logRecords }] }] };
}

/** A batch of spans with no attributes, each with a span's fields over its own. */
function spans(...records: object[]) {
  const own = records.map((span) => ({
    traceId: "6856a5e381eb349528cb7f1a43d05802",
    spanId: "24ecca8e68383c93",
    name: "GET",
    startTimeUnixNano: "1790773392219000000",
    endTimeUnixNano: "1790773392219000000",
    ...span,
  }));
  return { resourceSpans: [{ resource, scopeSpans: [{ spans: own }] }] };
}

/** The attributes of an uncaught exception's log record, and of a span's exception event. */
function exceptionAttributes(message: string, stack: string) {
  return [
    { key: "exception.type", value: { stringValue: "Error" } },
    { key: "exception.message", value: { stringValue: message } },
    { key: "exception.stacktrace", value: { stringValue: stack } },
  ];
}

/** What a row's cut columns kept, in UTF-16 units, beside the whole size its JSON column reports
 *  and the bytes of the row's own JSON. */
function sizes(row: {
  body?: string;
  body_bytes?: number;
  attributes?: string;
  attributes_bytes?: number;
  exception?: string;
  stack?: string;
}) {
  return {
    kept: (row.body || row.attributes)?.length,
    whole: row.body_bytes ?? row.attributes_bytes,
    exception: row.exception?.length,
    stack: row.stack?.length,
    json: new TextEncoder().encode(JSON.stringify(row)).byteLength,
  };
}

/** The body of an `invocation` row: Cloudflare's record of one GET of the producer, whole. */
function invocationBody(fetch: {
  path: string;
  query: string;
  status: number;
  invocation: string;
  ray: string;
  seq: number;
}) {
  const host = "telemetry-spike-producer.iterate-dev-preview.workers.dev";
  return JSON.stringify({
    message: `GET https://${host}${fetch.path}?${fetch.query}`,
    "cloudflare.execution_model": "stateless",
    "cloudflare.handler_type": "fetch",
    "faas.invocation_id": fetch.invocation,
    "cloudflare.ray_id": fetch.ray,
    "faas.trigger": "http",
    "url.full": `https://${host}${fetch.path}?${fetch.query}`,
    "http.request.method": "GET",
    "http.request.header.accept": "*/*",
    "http.request.header.accept-encoding": "gzip, br",
    "user_agent.original": "curl/8.7.1",
    "cloudflare.colo": "LHR",
    "cloudflare.verified_bot_category": "",
    "cloudflare.asn": 64496,
    "geo.timezone": "Europe/London",
    "geo.continent.code": "EU",
    "geo.country.code": "GB",
    "geo.locality.name": "London",
    "geo.locality.region": "England",
    "server.port": "",
    "server.address": host,
    "url.path": fetch.path,
    "url.query": fetch.query,
    "url.scheme": "https",
    "network.protocol.name": "https",
    "http.response.status_code": fetch.status,
    "cloudflare.invocation.sequence.number": fetch.seq,
  });
}

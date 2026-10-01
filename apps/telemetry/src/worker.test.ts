// The receiver through its `fetch` (worker.ts): what each request is answered, what reaches the
// two streams and what is logged. The streams are fakes that hold Pipelines' two limits
// (docs/telemetry.md). What a row holds is otlp.test.ts's.
import { gzipSync } from "node:zlib";
import type { Pipeline } from "cloudflare:pipelines";
import { expect, test, vi } from "vitest";
import logs from "./fixtures/logs.json" with { type: "json" };
import preflightLogs from "./fixtures/preflight-logs.json" with { type: "json" };
import traces from "./fixtures/traces.json" with { type: "json" };
import worker from "./worker.ts";

/** The header Cloudflare's export carries, as the destination holds it. */
const withSecret = { "x-telemetry-secret": "the secret" };

test.for([
  {
    name: "GET / says what the Worker is",
    request: new Request("https://telemetry.example/"),
    expected: { status: 200 },
  },
  {
    name: "an OTLP path answers a POST alone",
    request: new Request("https://telemetry.example/v1/logs"),
    expected: { status: 404 },
  },
  {
    name: "a dataset nothing exports is not found",
    request: post("/v1/metrics", JSON.stringify({})),
    expected: { status: 404 },
  },
  {
    name: "a wrong secret is answered 503, which Cloudflare sends again, and logged",
    request: post("/v1/logs", JSON.stringify(logs), { "x-telemetry-secret": "the previous one" }),
    expected: {
      status: 503,
      warned: [{ event: "telemetry.secret-refused", pathname: "/v1/logs" }],
    },
  },
  {
    name: "no secret is answered as a wrong one",
    request: post("/v1/traces", JSON.stringify(traces), {}),
    expected: {
      status: 503,
      warned: [{ event: "telemetry.secret-refused", pathname: "/v1/traces" }],
    },
  },
  {
    name: "a Worker that holds no secret refuses a request that sends none",
    request: post("/v1/logs", JSON.stringify(logs), {}),
    env: { TELEMETRY_OTLP_SECRET: undefined },
    expected: {
      status: 503,
      warned: [{ event: "telemetry.secret-refused", pathname: "/v1/logs" }],
    },
  },
  {
    name: "a Worker whose secret is empty refuses a request whose secret is empty",
    request: post("/v1/logs", JSON.stringify(logs), { "x-telemetry-secret": "" }),
    env: { TELEMETRY_OTLP_SECRET: "" },
    expected: {
      status: 503,
      warned: [{ event: "telemetry.secret-refused", pathname: "/v1/logs" }],
    },
  },
  {
    name: "a gzip batch of logs lands on the logs stream",
    request: post("/v1/logs", gzipSync(JSON.stringify(logs)), {
      ...withSecret,
      "content-encoding": "gzip",
    }),
    expected: { status: 200, logs: [8] },
  },
  {
    name: "a plain batch of spans lands on the spans stream",
    request: post("/v1/traces", JSON.stringify(traces)),
    expected: { status: 200, spans: [5] },
  },
  {
    name: "the destination's preflight is answered 200 and sends nothing",
    request: post("/v1/logs", JSON.stringify(preflightLogs)),
    expected: { status: 200 },
  },
  {
    name: "a batch that is no gzip is answered 400 and sends nothing",
    request: post("/v1/logs", JSON.stringify(logs), { ...withSecret, "content-encoding": "gzip" }),
    expected: {
      status: 400,
      warned: [
        { event: "telemetry.batch-unreadable", pathname: "/v1/logs", message: expect.any(String) },
      ],
    },
  },
  {
    name: "a batch that is no JSON is answered 400",
    request: post("/v1/traces", JSON.stringify(traces).slice(0, -1)),
    expected: {
      status: 400,
      warned: [
        {
          event: "telemetry.batch-unreadable",
          pathname: "/v1/traces",
          message: expect.stringContaining("SyntaxError"),
        },
      ],
    },
  },
  {
    name: "JSON that is no batch is answered 400",
    request: post("/v1/logs", JSON.stringify({ resourceLogs: "none" })),
    expected: {
      status: 400,
      warned: [
        {
          event: "telemetry.batch-unreadable",
          pathname: "/v1/logs",
          message: expect.stringContaining("resourceLogs"),
        },
      ],
    },
  },
  {
    name: "a batch with a record that does not parse lands the others, and the skip is logged",
    request: post("/v1/logs", JSON.stringify(lines({}, { timeUnixNano: "yesterday" }, {}))),
    expected: {
      status: 200,
      logs: [2],
      warned: [
        {
          event: "telemetry.records-skipped",
          pathname: "/v1/logs",
          skipped: 1,
          landed: 2,
          first: expect.stringContaining("timeUnixNano"),
        },
      ],
    },
  },
  {
    name: "a body that is 3 MB as JSON lands as a row a stream takes",
    request: post(
      "/v1/logs",
      JSON.stringify(lines({ body: { stringValue: "\u0000".repeat(512 * 1024) } })),
    ),
    expected: { status: 200, logs: [1] },
  },
  {
    name: "a row that a field no cut bounds takes over 1 MB is skipped, and the others land",
    request: post(
      "/v1/logs",
      JSON.stringify(
        lines(
          {},
          {
            body: {
              kvlistValue: {
                values: [{ key: "event", value: { stringValue: "e".repeat(1_100_000) } }],
              },
            },
          },
          {},
        ),
      ),
    ),
    expected: {
      status: 200,
      logs: [2],
      warned: [
        {
          event: "telemetry.records-skipped",
          pathname: "/v1/logs",
          skipped: 1,
          landed: 2,
          first: "a row over 1 MB, which no stream takes",
        },
      ],
    },
  },
  {
    name: "a batch over a send's 5 MB goes in sends under it",
    request: post(
      "/v1/logs",
      JSON.stringify(lines(...Array(10).fill({ body: { stringValue: "x".repeat(500_000) } }))),
    ),
    expected: { status: 200, logs: [8, 2] },
  },
  {
    name: "a send that lost its connection is answered 503, to be sent again a second later",
    request: post("/v1/logs", JSON.stringify(logs)),
    sendFails: Object.assign(new Error("Network connection lost."), { retryable: true }),
    expected: {
      status: 503,
      retryAfter: "1",
      warned: [
        {
          event: "telemetry.platform-failure-send",
          kind: "disconnected",
          pathname: "/v1/logs",
          message: "Error: Network connection lost.",
        },
      ],
    },
  },
  {
    name: "a send to an overloaded stream is answered 503, to be sent again ten seconds later",
    request: post("/v1/traces", JSON.stringify(traces)),
    sendFails: Object.assign(new Error("the stream is busy"), { overloaded: true }),
    expected: {
      status: 503,
      retryAfter: "10",
      warned: [
        {
          event: "telemetry.platform-failure-send",
          kind: "overloaded",
          pathname: "/v1/traces",
          message: "Error: the stream is busy",
        },
      ],
    },
  },
])("$name", async ({ request, env, sendFails, expected }) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sent = { logs: [], spans: [] };
  const response = await worker.fetch(request, {
    TELEMETRY_OTLP_SECRET: "the secret",
    LOGS: stream(sent.logs, sendFails),
    SPANS: stream(sent.spans, sendFails),
    ...env,
  });

  // exact: what a row does not name was not sent and not logged
  expect({
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    ...sent,
    warned: warn.mock.calls.map(([line]) => line),
  }).toEqual({ retryAfter: null, logs: [], spans: [], warned: [], ...expected });
});

test("a send that fails for no reason the platform names escapes, which workerd answers 500", async () => {
  const fetched = worker.fetch(post("/v1/logs", JSON.stringify(logs)), {
    TELEMETRY_OTLP_SECRET: "the secret",
    LOGS: stream([], new Error("a defect of ours")),
    SPANS: stream([]),
  });

  await expect(fetched).rejects.toThrow("a defect of ours");
});

/** A POST to the Worker, with the secret unless `headers` are named. */
function post(pathname: string, body: BodyInit, headers: Record<string, string> = withSecret) {
  return new Request(`https://telemetry.example${pathname}`, { method: "POST", body, headers });
}

/** A batch of one Worker's `console.log` lines, each a record's fields. */
function lines(...records: object[]) {
  const resource = {
    attributes: [{ key: "cloudflare.script_name", value: { stringValue: "os" } }],
  };
  const logRecords = records.map((record) => ({
    attributes: [{ key: "name", value: { stringValue: "log" } }],
    ...record,
  }));
  return { resourceLogs: [{ resource, scopeLogs: [{ logRecords }] }] };
}

/** A stream as the Worker binds one. It fails every send with `fails`, and otherwise refuses what
 *  Pipelines does: a send over 5 MB, and one holding a row over 1 MB. `sends` takes how many rows
 *  each send it accepted held. */
function stream(sends: number[], fails?: Error): Pipeline {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return {
    async send(rows) {
      if (fails) throw fails;
      if (bytes(rows) > 5 * 1024 * 1024) throw new Error("a send over 5 MB");
      if (rows.some((row) => bytes(row) > 1024 * 1024)) throw new Error("a row over 1 MB");
      sends.push(rows.length);
    },
  };
}

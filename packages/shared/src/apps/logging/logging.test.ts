import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../jonasland/strip-ansi.ts";
import {
  withEvlog,
  createPrettyStdoutDrain,
  formatCompactDuration,
  installEvlogConsoleFilter,
  renderPrettyStdoutEvent,
  shouldKeepAppRequestLog,
  writeRawStdoutEvent,
} from "./with-evlog.ts";

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
const consoleFilterKey = Symbol.for("iterate.evlog.console-filter-installed");
const appManifest = {
  packageName: "@iterate-com/example",
  version: "0.0.1",
  slug: "example",
  description: "Example App",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  delete (globalThis as typeof globalThis & Record<symbol, boolean | undefined>)[consoleFilterKey];
});

describe("shouldKeepAppRequestLog", () => {
  it("drops successful posthog-proxy traffic including 304 Not Modified", () => {
    expect(
      shouldKeepAppRequestLog({
        path: "/posthog-proxy/static/web-vitals.js",
        status: 304,
        hasError: false,
      }),
    ).toBe(false);
  });

  it("keeps posthog-proxy responses that are not covered by the drop rule", () => {
    expect(
      shouldKeepAppRequestLog({
        path: "/posthog-proxy/e",
        status: 500,
        hasError: false,
      }),
    ).toBe(true);
  });
});

describe("apps logging pretty stdout", () => {
  it("formats compact durations", () => {
    expect(formatCompactDuration(0)).toBe("0ms");
    expect(formatCompactDuration(41)).toBe("41ms");
    expect(formatCompactDuration(999)).toBe("999ms");
    expect(formatCompactDuration(1000)).toBe("1.00s");
    expect(formatCompactDuration(1023)).toBe("1.02s");
  });

  it("renders request logs line-by-line with delta timestamps", () => {
    const output = stripAnsi(
      renderPrettyStdoutEvent({
        timestamp: "2026-03-26T12:56:38.515Z",
        level: "info",
        appName: "@iterate-com/example",
        message: "POST /api/test/log-demo 200 in 302ms (3 lines)",
        method: "POST",
        path: "/api/test/log-demo",
        status: 200,
        duration: "302ms",
        durationMs: 302,
        requestId: "req_123",
        app: {
          slug: "example",
          packageName: "@iterate-com/example",
        },
        config: {
          logs: {
            stdoutFormat: "pretty",
            filtering: {
              rules: [],
            },
          },
        },
        rpc: {
          url: "http://localhost:5174/api/test/log-demo",
          procedurePath: "test.logDemo",
        },
        logDemo: {
          phase: "completed",
          label: "frontend-button",
          totalSteps: 3,
        },
        requestLogs: [
          {
            level: "info",
            message: "example.test.log-demo.received",
            timestamp: "2026-03-26T12:56:38.213Z",
          },
          {
            level: "info",
            message: "example.test.log-demo.midpoint",
            timestamp: "2026-03-26T12:56:38.332Z",
          },
          {
            level: "warn",
            message: "example.test.log-demo.completed",
            timestamp: "2026-03-26T12:56:38.515Z",
          },
        ],
      }),
    );

    expect(output).toContain(
      "12:56:38.515 INFO [@iterate-com/example] POST /api/test/log-demo 200 in 302ms (3 lines)",
    );
    expect(output).toContain(
      "rpc: url=http://localhost:5174/api/test/log-demo procedurePath=test.logDemo",
    );
    expect(output).toContain("logDemo:");
    expect(output).toContain("phase: completed");
    expect(output).toContain("label: frontend-button");
    expect(output).toContain("totalSteps: 3");
    expect(output).toContain("+0ms   INFO  example.test.log-demo.received");
    expect(output).toContain("+119ms INFO  example.test.log-demo.midpoint");
    expect(output).toContain("+183ms WARN  example.test.log-demo.completed");
    expect(output).toContain("INFO  Request ended at 12:56:38.515 after 302ms");
    expect(output).not.toContain("0={");
    expect(output).not.toContain("requestId:");
    expect(output).not.toContain("app:");
    expect(output).not.toContain("config:");
  });

  it("uses compact seconds for header duration and log deltas when >= 1s", () => {
    const output = stripAnsi(
      renderPrettyStdoutEvent({
        timestamp: "2026-03-26T12:56:40.000Z",
        level: "info",
        appName: "@iterate-com/example",
        method: "GET",
        path: "/slow",
        status: 200,
        durationMs: 1023,
        requestLogs: [
          {
            level: "info",
            message: "first",
            timestamp: "2026-03-26T12:56:38.000Z",
          },
          {
            level: "info",
            message: "second",
            timestamp: "2026-03-26T12:56:39.500Z",
          },
        ],
      }),
    );

    expect(output).toContain("GET /slow 200 in 1.02s");
    expect(output).toContain("+0ms   INFO  first");
    expect(output).toContain("+1.50s INFO  second");
    expect(output).toContain("INFO  Request ended at 12:56:40.000 after 1.02s");
  });

  it("prefers the event message over recomputing the header summary", () => {
    const output = stripAnsi(
      renderPrettyStdoutEvent({
        timestamp: "2026-03-26T12:56:38.515Z",
        level: "info",
        appName: "@iterate-com/example",
        message: "GET /debug 200 in 41ms (0 lines)",
        method: "GET",
        path: "/debug",
        status: 200,
        duration: "41ms",
      }),
    );

    expect(output).toContain(
      "12:56:38.515 INFO [@iterate-com/example] GET /debug 200 in 41ms (0 lines)",
    );
    expect(output).not.toContain(
      "GET /debug 200 in 41ms (0 lines) GET /debug 200 in 41ms (0 lines)",
    );
  });

  it("prints through the drain wrapper", () => {
    const writer = vi.fn();
    const drain = createPrettyStdoutDrain(writer);

    drain({
      event: {
        timestamp: "2026-03-26T12:56:38.515Z",
        level: "info",
        appName: "@iterate-com/example",
        method: "GET",
        path: "/debug",
        status: 200,
        duration: "41ms",
      },
    });

    expect(writer).toHaveBeenCalledTimes(1);
    expect(stripAnsi(writer.mock.calls[0]![0] as string)).toContain(
      "12:56:38.515 INFO [@iterate-com/example] GET /debug 200 in 41ms",
    );
  });

  it("filters raw evlog wide-event console objects but keeps normal console output", () => {
    const logSpy = vi.fn();
    console.log = logSpy;
    console.info = logSpy;
    console.warn = logSpy;
    console.error = logSpy;

    installEvlogConsoleFilter();

    console.info({
      timestamp: "2026-03-26T12:56:38.515Z",
      level: "info",
      appName: "@iterate-com/example",
      method: "GET",
      path: "/debug",
    });
    console.log("plain output");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("plain output");
  });

  it("writes raw stdout events as structured JSON without ANSI and keeps request logs verbatim", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const event = {
      timestamp: "2026-03-26T12:56:38.515Z",
      level: "error",
      appName: "@iterate-com/example",
      message: "POST /api/test/log-demo 200 in 302ms (2 lines)",
      rpc: {
        url: "http://localhost:5174/api/test/log-demo",
        procedurePath: "test.logDemo",
      },
      requestLogs: [
        {
          level: "info",
          message: "example.test.log-demo.received",
          timestamp: "2026-03-26T12:56:38.213Z",
        },
        {
          level: "warn",
          message: "example.test.log-demo.completed",
          timestamp: "2026-03-26T12:56:38.515Z",
        },
      ],
    };

    writeRawStdoutEvent(event);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = String(writeSpy.mock.calls[0]![0]);
    expect(output).not.toContain("\u001b[");

    const parsed = JSON.parse(output.trimEnd()) as typeof event;
    expect(parsed.message).toBe("POST /api/test/log-demo 200 in 302ms (2 lines)");
    expect(parsed.requestLogs).toEqual(event.requestLogs);
    expect(parsed.rpc).toEqual(event.rpc);
  });

  it("withEvlog raw mode writes a structured one-line summary and preserves request logs", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await withEvlog(
      {
        request: new Request("https://example.com/api/test/log-demo", {
          method: "POST",
        }),
        manifest: appManifest,
        config: {
          logs: {
            stdoutFormat: "raw",
            filtering: {
              rules: [],
            },
          },
        },
      },
      async ({ log }) => {
        log.info("example.test.log-demo.received");
        return new Response("ok", { status: 200 });
      },
    );

    expect(writeSpy).toHaveBeenCalled();
    const output = String(writeSpy.mock.calls.at(-1)![0]);
    expect(output).not.toContain("\u001b[");

    const parsed = JSON.parse(output.trimEnd()) as {
      message: string;
      requestLogs: Array<{ level?: string; message?: string }>;
    };
    expect(parsed.message).toMatch(/^POST \/api\/test\/log-demo 200 in \d+ms \(1 line\)$/);
    expect(parsed.message).not.toContain("\n");
    expect(parsed.requestLogs).toEqual([
      expect.objectContaining({
        level: "info",
        message: "example.test.log-demo.received",
      }),
    ]);
  });
});

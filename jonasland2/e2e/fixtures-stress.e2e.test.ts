import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { mockttpProxyFixture, waitForHttpOk } from "./lib/fixtures.ts";

const fixtureIds = Array.from({ length: 12 }, (_, index) => `fixture-${String(index + 1)}`);

function headerValue(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

describe("fixtures stress", () => {
  test.concurrent("mockttpProxyFixture isolates 12 fixtures under burst load", async () => {
    const fixtures = await Promise.all(
      fixtureIds.map(() => mockttpProxyFixture({ onUnhandledRequest: "error" })),
    );

    try {
      await Promise.all(
        fixtureIds.map(async (fixtureId, index) => {
          await fixtures[index].server.forGet("/burst").thenCallback((request) => ({
            statusCode: 200,
            json: {
              fixtureId,
              requestId: headerValue(request.headers, "x-request-id"),
            },
          }));
        }),
      );

      await Promise.all(
        fixtures.map(async (fixture, index) => {
          const fixtureId = fixtureIds[index];
          const requestCount = 20;

          const responses = await Promise.all(
            Array.from({ length: requestCount }, async (_, requestIndex) => {
              const requestId = `${fixtureId}-${String(requestIndex + 1)}`;
              const response = await fetch(`${fixture.hostProxyUrl}/burst`, {
                headers: {
                  "x-request-id": requestId,
                },
              });
              return { response, requestId };
            }),
          );

          for (const { response, requestId } of responses) {
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              fixtureId,
              requestId,
            });
          }

          expect(fixture.listRequests()).toHaveLength(requestCount);
          expect(fixture.listUnhandledRequests()).toHaveLength(0);
          fixture.expectNoUnhandledRequests();
        }),
      );
    } finally {
      await Promise.all(fixtures.map(async (fixture) => await fixture[Symbol.asyncDispose]()));
    }
  });

  test.concurrent("late rules with higher priority stay local per fixture", async () => {
    const fixtures = await Promise.all(
      fixtureIds.slice(0, 6).map(() => mockttpProxyFixture({ onUnhandledRequest: "error" })),
    );

    try {
      await Promise.all(
        fixtures.map(async (fixture, index) => {
          const fixtureId = fixtureIds[index];
          await fixture.server.forGet("/churn").thenJson(200, { fixtureId, version: "initial" });

          const initial = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(initial.status).toBe(200);
          expect(await initial.json()).toEqual({ fixtureId, version: "initial" });

          await fixture.server
            .forGet("/churn")
            .asPriority(10)
            .thenJson(200, { fixtureId, version: "runtime" });

          const runtime = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(runtime.status).toBe(200);
          expect(await runtime.json()).toEqual({ fixtureId, version: "runtime" });
        }),
      );
    } finally {
      await Promise.all(fixtures.map(async (fixture) => await fixture[Symbol.asyncDispose]()));
    }
  });

  test.concurrent("onUnhandledRequest=error returns 500 and records unhandled", async () => {
    await using fixture = await mockttpProxyFixture({ onUnhandledRequest: "error" });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-error`);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("mock_unhandled_request");
    expect(body.message).toContain("Unhandled request: GET");
    expect(body.message).toContain("/no-match-error");

    const unhandled = await fixture.waitForRequest(
      { pathname: "/no-match-error" },
      { source: "unhandled" },
    );
    expect(new URL(unhandled.url).pathname).toBe("/no-match-error");
    expect(() => fixture.expectNoUnhandledRequests()).toThrow(
      /Mockttp captured unmatched requests/,
    );
  });

  test.concurrent("onUnhandledRequest=bypass returns 404 and records unhandled", async () => {
    await using fixture = await mockttpProxyFixture({ onUnhandledRequest: "bypass" });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-bypass`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("mock_not_found");
    expect(body.message).toContain("Unhandled request: GET");
    expect(body.message).toContain("/no-match-bypass");

    const unhandled = await fixture.expectRequest(
      { pathname: "/no-match-bypass" },
      { source: "unhandled" },
    );
    expect(new URL(unhandled.url).pathname).toBe("/no-match-bypass");
  });

  test.concurrent("waitForRequest timeout includes filter and seen output", async () => {
    await using fixture = await mockttpProxyFixture({ onUnhandledRequest: "bypass" });
    await fixture.server.forGet("/hit").thenJson(200, { ok: true });

    const hit = await fetch(`${fixture.hostProxyUrl}/hit`);
    expect(hit.status).toBe(200);

    await expect(
      fixture.waitForRequest({ pathname: "/never" }, { timeoutMs: 120 }),
    ).rejects.toThrow(/Timed out waiting for all request/);
  });

  test.concurrent("proxy urls share same dynamic port and disposer closes listener", async () => {
    const fixture = await mockttpProxyFixture({ onUnhandledRequest: "bypass" });
    const hostPort = new URL(fixture.hostProxyUrl).port;
    const dockerPort = new URL(fixture.proxyUrl).port;
    expect(hostPort).toBe(dockerPort);

    const hostProxyUrl = fixture.hostProxyUrl;
    await fixture[Symbol.asyncDispose]();
    await expect(fetch(`${hostProxyUrl}/after-dispose`)).rejects.toThrow();
  });

  test.concurrent("waitForHttpOk survives delayed readiness", async () => {
    let ready = false;
    const server = createServer((_req, res) => {
      if (!ready) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("not-ready");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    server.listen(0, "127.0.0.1");
    await delay(80);
    ready = true;

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      await expect(waitForHttpOk(`http://127.0.0.1:${String(address.port)}`, 2_000)).resolves.toBe(
        undefined,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

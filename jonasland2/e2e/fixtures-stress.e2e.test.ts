import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { mockttpFixture, waitForHttpOk } from "./lib/fixtures.ts";

const fixtureIds = Array.from({ length: 12 }, (_, index) => `fixture-${String(index + 1)}`);

function headerValue(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

describe("fixtures stress", () => {
  test.concurrent("mockttp fixture isolates 12 fixtures under burst load", async () => {
    const fixtures = await Promise.all(fixtureIds.map(() => mockttpFixture()));

    try {
      const burstEndpoints = await Promise.all(
        fixtureIds.map(async (fixtureId, index) => {
          return await fixtures[index].server.forGet("/burst").thenCallback((request) => ({
            statusCode: 200,
            json: {
              fixtureId,
              requestId: headerValue(request.headers, "x-request-id"),
            },
          }));
        }),
      );
      const unmatchedEndpoints = await Promise.all(
        fixtures.map((fixture) => fixture.server.forUnmatchedRequest().always().thenReply(599)),
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

          const seen = await burstEndpoints[index].getSeenRequests();
          expect(seen).toHaveLength(requestCount);
          const unhandled = await unmatchedEndpoints[index].getSeenRequests();
          expect(unhandled).toHaveLength(0);
        }),
      );
    } finally {
      await Promise.all(fixtures.map(async (fixture) => await fixture[Symbol.asyncDispose]()));
    }
  });

  test.concurrent("late rules with higher priority stay local per fixture", async () => {
    const fixtures = await Promise.all(fixtureIds.slice(0, 6).map(() => mockttpFixture()));

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

  test.concurrent("custom unmatched rule returns 500 and records unhandled", async () => {
    await using fixture = await mockttpFixture();
    const unmatchedEndpoint = await fixture.server
      .forUnmatchedRequest()
      .always()
      .thenCallback((request) => {
        const message = `Unhandled request: ${request.method.toUpperCase()} ${request.url}`;
        return {
          statusCode: 500,
          json: { error: "mock_unhandled_request", message },
        };
      });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-error`);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("mock_unhandled_request");
    expect(body.message).toContain("Unhandled request: GET");
    expect(body.message).toContain("/no-match-error");

    const unhandled = await unmatchedEndpoint.getSeenRequests();
    expect(unhandled.some((request) => new URL(request.url).pathname === "/no-match-error")).toBe(
      true,
    );
  });

  test.concurrent("custom unmatched rule returns 404 and records unhandled", async () => {
    await using fixture = await mockttpFixture();
    const unmatchedEndpoint = await fixture.server
      .forUnmatchedRequest()
      .always()
      .thenCallback((request) => {
        const message = `Unhandled request: ${request.method.toUpperCase()} ${request.url}`;
        return {
          statusCode: 404,
          json: { error: "mock_not_found", message },
        };
      });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-bypass`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("mock_not_found");
    expect(body.message).toContain("Unhandled request: GET");
    expect(body.message).toContain("/no-match-bypass");

    const unhandled = await unmatchedEndpoint.getSeenRequests();
    expect(unhandled.some((request) => new URL(request.url).pathname === "/no-match-bypass")).toBe(
      true,
    );
  });

  test.concurrent("mockttp seen request APIs stay minimal and explicit", async () => {
    await using fixture = await mockttpFixture();
    const unmatchedEndpoint = await fixture.server.forUnmatchedRequest().always().thenReply(599);
    const endpoint = await fixture.server.forGet("/hit").thenJson(200, { ok: true });

    const hit = await fetch(`${fixture.hostProxyUrl}/hit`);
    expect(hit.status).toBe(200);

    const seen = await endpoint.getSeenRequests();
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe("/hit");
    const unhandled = await unmatchedEndpoint.getSeenRequests();
    expect(unhandled).toHaveLength(0);
  });

  test.concurrent("proxy urls share same dynamic port and disposer closes listener", async () => {
    const fixture = await mockttpFixture();
    const hostPort = new URL(fixture.hostProxyUrl).port;
    const dockerPort = new URL(fixture.proxyUrl).port;
    expect(hostPort).toBe(dockerPort);

    const hostProxyUrl = fixture.hostProxyUrl;
    await fixture[Symbol.asyncDispose]();
    const statusAfterDispose = await fetch(`${hostProxyUrl}/after-dispose`)
      .then((response) => response.status)
      .catch(() => -1);
    expect(statusAfterDispose === -1 || statusAfterDispose === 503).toBe(true);
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

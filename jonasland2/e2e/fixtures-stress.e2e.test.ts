import { HttpResponse, http } from "msw";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { mswProxyFixture, waitForHttpOk } from "./lib/fixtures.ts";

const fixtureIds = Array.from({ length: 12 }, (_, index) => `fixture-${String(index + 1)}`);

describe("fixtures stress", () => {
  test.concurrent("mswProxyFixture isolates 12 fixtures under burst load", async () => {
    const fixtures = await Promise.all(
      fixtureIds.map(() => mswProxyFixture({ onUnhandledRequest: "error" })),
    );

    try {
      fixtureIds.forEach((fixtureId, index) => {
        fixtures[index].use(
          http.get("https://upstream.iterate.localhost/burst", ({ request }) => {
            return HttpResponse.json({
              fixtureId,
              requestId: request.headers.get("x-request-id"),
            });
          }),
        );
      });

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

          expect(fixture.listRequests("start")).toHaveLength(requestCount);
          expect(fixture.listRequests("match")).toHaveLength(requestCount);
          expect(fixture.listRequests("unhandled")).toHaveLength(0);
          expect(fixture.listRequests("end")).toHaveLength(requestCount);
          fixture.expectNoUnhandledRequests();
        }),
      );
    } finally {
      await Promise.all(fixtures.map(async (fixture) => await fixture[Symbol.asyncDispose]()));
    }
  });

  test.concurrent("handler churn (use/reset/reset-with-new) stays local per fixture", async () => {
    const fixtures = await Promise.all(
      fixtureIds.slice(0, 6).map((fixtureId) =>
        mswProxyFixture({
          onUnhandledRequest: "error",
          handlers: [
            http.get("https://upstream.iterate.localhost/churn", () =>
              HttpResponse.json({ fixtureId, version: "initial" }),
            ),
          ],
        }),
      ),
    );

    try {
      await Promise.all(
        fixtures.map(async (fixture, index) => {
          const fixtureId = fixtureIds[index];

          const initial = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(initial.status).toBe(200);
          expect(await initial.json()).toEqual({ fixtureId, version: "initial" });

          fixture.use(
            http.get("https://upstream.iterate.localhost/churn", () =>
              HttpResponse.json({ fixtureId, version: "runtime" }),
            ),
          );

          const runtime = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(runtime.status).toBe(200);
          expect(await runtime.json()).toEqual({ fixtureId, version: "runtime" });

          fixture.resetHandlers();
          const afterReset = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(afterReset.status).toBe(200);
          expect(await afterReset.json()).toEqual({ fixtureId, version: "initial" });

          fixture.resetHandlers(
            http.get("https://upstream.iterate.localhost/churn", () =>
              HttpResponse.json({ fixtureId, version: "override" }),
            ),
          );
          const afterOverride = await fetch(`${fixture.hostProxyUrl}/churn`);
          expect(afterOverride.status).toBe(200);
          expect(await afterOverride.json()).toEqual({ fixtureId, version: "override" });
        }),
      );
    } finally {
      await Promise.all(fixtures.map(async (fixture) => await fixture[Symbol.asyncDispose]()));
    }
  });

  test.concurrent("onUnhandledRequest=error returns 500 and records unhandled", async () => {
    await using fixture = await mswProxyFixture({ onUnhandledRequest: "error" });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-error`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "msw_unhandled_request",
      message: "Unhandled request: GET https://upstream.iterate.localhost/no-match-error",
    });

    const unhandled = await fixture.waitForRequest(
      { pathname: "/no-match-error" },
      { phase: "unhandled" },
    );
    expect(unhandled.url.pathname).toBe("/no-match-error");
    expect(() => fixture.expectNoUnhandledRequests()).toThrow(/MSW captured unhandled requests/);
  });

  test.concurrent("onUnhandledRequest=bypass returns 404 and records unhandled", async () => {
    await using fixture = await mswProxyFixture({ onUnhandledRequest: "bypass" });
    const response = await fetch(`${fixture.hostProxyUrl}/no-match-bypass`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "mock_not_found",
      message: "Unhandled request: GET https://upstream.iterate.localhost/no-match-bypass",
    });

    const unhandled = await fixture.expectRequest(
      { pathname: "/no-match-bypass" },
      { phase: "unhandled" },
    );
    expect(unhandled.url.pathname).toBe("/no-match-bypass");
  });

  test.concurrent("waitForRequest timeout includes filter and seen output", async () => {
    await using fixture = await mswProxyFixture({ onUnhandledRequest: "bypass" });

    fixture.use(
      http.get("https://upstream.iterate.localhost/hit", () => HttpResponse.json({ ok: true })),
    );

    const hit = await fetch(`${fixture.hostProxyUrl}/hit`);
    expect(hit.status).toBe(200);

    await expect(
      fixture.waitForRequest({ pathname: "/never" }, { timeoutMs: 120, phase: "match" }),
    ).rejects.toThrow(/Timed out waiting for MSW match request/);
  });

  test.concurrent("proxy urls share same dynamic port and disposer closes listener", async () => {
    const fixture = await mswProxyFixture({ onUnhandledRequest: "bypass" });
    const hostPort = new URL(fixture.hostProxyUrl).port;
    const dockerPort = new URL(fixture.proxyUrl).port;
    expect(hostPort).toBe(dockerPort);

    const hostProxyUrl = fixture.hostProxyUrl;
    await fixture[Symbol.asyncDispose]();
    await expect(fetch(`${hostProxyUrl}/after-dispose`)).rejects.toThrow();
  });

  test.concurrent("boundary wrapper preserves callback semantics", async () => {
    await using fixture = await mswProxyFixture();
    const callback = fixture.boundary(async (a: number, b: number) => {
      await delay(5);
      return a + b;
    });

    await expect(callback(20, 22)).resolves.toBe(42);
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

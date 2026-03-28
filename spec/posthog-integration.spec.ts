import http from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";
import { test } from "./test-helpers.ts";
import { fetchWithManualRedirect } from "./helpers/fetch.ts";

test("captures a trpc procedure error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `trpc-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/throwTrpcError",
    input: { message: `[test_trpc_error] ${marker}` },
  });

  expect(response.ok).toBe(false);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.event).toBe("$exception");
  expect(captured.body.properties).toEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        path: "/api/orpc/testing/throwTrpcError",
        method: "POST",
      }),
    }),
  );
});

test("captures a hono endpoint error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `hono-${crypto.randomUUID()}`;
  const response = await integration.callEndpoint({
    path: `/api/testing/throw-hono-error?marker=${marker}`,
  });

  expect(response.ok).toBe(false);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        path: "/api/testing/throw-hono-error",
        method: "GET",
      }),
    }),
  );
});

test("does not capture PostHog for successful outbox consumer flow", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-success-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/emitSuccessfulOutboxEvent",
    input: { message: marker },
  });

  expect(response.ok).toBe(true);
  await expect.poll(() => integration.capture.requests.length, { timeout: 1_000 }).toBe(0);
});

test("captures an outbox consumer error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-fail-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/emitFailingOutboxEvent",
    input: { message: marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        path: "/api/orpc/testing/emitFailingOutboxEvent",
        method: "POST",
      }),
    }),
  );
});

test("captures a malformed outbox job error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `malformed-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/insertMalformedOutboxJob",
    input: { marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("invalid message"),
  });

  expect(captured.body.properties).toEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        path: "/api/orpc/testing/insertMalformedOutboxJob",
        method: "POST",
      }),
    }),
  );
});

test("captures a missing consumer error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `missing-consumer-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/insertMissingConsumerOutboxJob",
    input: { marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("no consumer found"),
  });

  expect(captured.body.properties).toEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        path: "/api/orpc/testing/insertMissingConsumerOutboxJob",
        method: "POST",
      }),
    }),
  );
});

type CapturedPostHogRequest = {
  path: string;
  body: Record<string, unknown>;
};

type PostHogIntegrationContext = {
  capture: {
    requests: CapturedPostHogRequest[];
    waitForRequest(params: {
      timeoutMs?: number;
      predicate?: (body: Record<string, unknown>) => boolean;
    }): Promise<CapturedPostHogRequest>;
  };
  callProcedure(params: { name: string; input?: unknown }): Promise<Response>;
  callEndpoint(params: { path: string }): Promise<Response>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function createPostHogIntegration(): Promise<PostHogIntegrationContext> {
  const requests: CapturedPostHogRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: req.url ?? "/",
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind capture server");
  }
  const captureOrigin = `http://127.0.0.1:${address.port}`;

  return {
    capture: {
      requests,
      async waitForRequest(params: {
        timeoutMs?: number;
        predicate?: (body: Record<string, unknown>) => boolean;
      }) {
        const timeoutMs = params.timeoutMs ?? 5_000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const match = requests.find((request) =>
            params.predicate ? params.predicate(request.body) : true,
          );
          if (match) return match;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error(
          `Timed out waiting for captured PostHog request. Saw ${requests.length} requests.`,
        );
      },
    },
    async callProcedure(params: { name: string; input?: unknown }): Promise<Response> {
      return await fetchWithManualRedirect(`/api/orpc/${params.name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-replace-posthog-egress": captureOrigin,
        },
        body: JSON.stringify({ json: params.input ?? {} }),
      });
    },
    async callEndpoint(params: { path: string }): Promise<Response> {
      return await fetchWithManualRedirect(params.path, {
        headers: {
          "x-replace-posthog-egress": captureOrigin,
        },
      });
    },
    async [Symbol.asyncDispose](): Promise<void> {
      server.close();
      await once(server, "close");
    },
  };
}

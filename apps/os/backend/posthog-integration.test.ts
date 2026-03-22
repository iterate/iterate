import http from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveLocalDockerPostgresPort } from "../scripts/local-docker-postgres-port.ts";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

type CapturedPostHogRequest = {
  path: string;
  body: Record<string, unknown>;
};

function createExecutionContext() {
  const promises: Array<Promise<unknown>> = [];

  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(Promise.resolve(promise));
      },
      passThroughOnException() {},
    },
    async drain() {
      while (promises.length > 0) {
        const batch = promises.splice(0, promises.length);
        await Promise.allSettled(batch);
      }
    },
  };
}

function createCaptureServer() {
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

  return {
    server,
    requests,
    clear() {
      requests.length = 0;
    },
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
  };
}

function ensureTestEnv() {
  process.env.DATABASE_URL ||= `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`;

  const required = [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "VITE_PUBLIC_URL",
    "SIGNUP_ALLOWLIST",
    "POSTHOG_PUBLIC_KEY",
  ] as const;

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing ${key}. Run with doppler dev env for posthog integration tests.`);
    }
  }
}

function createWorkerEnv() {
  return {
    ...process.env,
    REALTIME_PUSHER: {
      idFromName: () => ({ toString: () => "stub" }),
      get: () => ({ fetch: () => new Response("not implemented", { status: 501 }) }),
    },
    APPROVAL_COORDINATOR: {
      idFromName: () => ({ toString: () => "stub" }),
      get: () => ({ fetch: () => new Response("not implemented", { status: 501 }) }),
    },
  } as never;
}

async function callProcedure<T>(params: {
  app: any;
  env: unknown;
  name: string;
  input?: unknown;
  captureOrigin: string;
}) {
  const execution = createExecutionContext();
  const response = await params.app.fetch(
    new Request(`https://os.example/api/orpc/${params.name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-replace-posthog-egress": params.captureOrigin,
      },
      body: JSON.stringify({ json: params.input ?? {} }),
    }),
    params.env as never,
    execution.ctx as never,
  );

  await execution.drain();
  const payload = (await response.json().catch(() => null)) as { json?: T; error?: unknown } | null;
  return { response, payload };
}

async function callEndpoint(params: {
  app: any;
  env: unknown;
  path: string;
  captureOrigin: string;
}) {
  const execution = createExecutionContext();
  const response = await params.app.fetch(
    new Request(`https://os.example${params.path}`, {
      headers: {
        "x-replace-posthog-egress": params.captureOrigin,
      },
    }),
    params.env as never,
    execution.ctx as never,
  );

  await execution.drain();
  return response;
}

const hasIntegrationEnv = [
  process.env.BETTER_AUTH_SECRET,
  process.env.VITE_PUBLIC_URL,
  process.env.SIGNUP_ALLOWLIST,
  process.env.POSTHOG_PUBLIC_KEY,
].every(Boolean);

describe.skipIf(process.env.CI || !hasIntegrationEnv)("PostHog integration", () => {
  const capture = createCaptureServer();
  let captureOrigin = "";
  let app: Awaited<typeof import("./worker.ts")>["app"];
  let env: unknown;

  beforeAll(async () => {
    ensureTestEnv();
    capture.server.listen(0, "127.0.0.1");
    await once(capture.server, "listening");
    const address = capture.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind capture server");
    }
    captureOrigin = `http://127.0.0.1:${address.port}`;

    const workerModule = await import("./worker.ts");
    app = workerModule.app;
    env = createWorkerEnv();
  }, 30_000);

  afterAll(async () => {
    capture.server.close();
    await once(capture.server, "close");
  });

  beforeEach(() => {
    capture.clear();
  });

  test("captures a trpc procedure error", async () => {
    const marker = `trpc-${crypto.randomUUID()}`;
    const { response } = await callProcedure({
      app,
      env,
      name: "testing/throwTrpcError",
      input: { message: `[test_trpc_error] ${marker}` },
      captureOrigin,
    });

    expect(response.ok).toBe(false);

    const captured = await capture.waitForRequest({
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
  }, 30_000);

  test("captures a hono endpoint error", async () => {
    const marker = `hono-${crypto.randomUUID()}`;
    const response = await callEndpoint({
      app,
      env,
      path: `/api/testing/throw-hono-error?marker=${marker}`,
      captureOrigin,
    });

    expect(response.ok).toBe(false);

    const captured = await capture.waitForRequest({
      predicate: (body) => JSON.stringify(body).includes(marker),
    });

    expect(captured.body.properties).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({ path: "/api/testing/throw-hono-error", method: "GET" }),
      }),
    );
  }, 30_000);

  test("does not capture PostHog for successful outbox consumer flow", async () => {
    const marker = `outbox-success-${crypto.randomUUID()}`;
    const { response } = await callProcedure({
      app,
      env,
      name: "testing/emitSuccessfulOutboxEvent",
      input: { message: marker },
      captureOrigin,
    });

    expect(response.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(capture.requests).toHaveLength(0);
  }, 30_000);

  test("captures an outbox consumer error", async () => {
    const marker = `outbox-fail-${crypto.randomUUID()}`;
    const { response } = await callProcedure({
      app,
      env,
      name: "testing/emitFailingOutboxEvent",
      input: { message: marker },
      captureOrigin,
    });

    expect(response.ok).toBe(true);

    const captured = await capture.waitForRequest({
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
  }, 30_000);

  test("captures a malformed outbox job error", async () => {
    const marker = `malformed-${crypto.randomUUID()}`;
    const { response } = await callProcedure({
      app,
      env,
      name: "testing/insertMalformedOutboxJob",
      input: { marker },
      captureOrigin,
    });

    expect(response.ok).toBe(true);

    const captured = await capture.waitForRequest({
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
  }, 30_000);

  test("captures a missing consumer error", async () => {
    const marker = `missing-consumer-${crypto.randomUUID()}`;
    const { response } = await callProcedure({
      app,
      env,
      name: "testing/insertMissingConsumerOutboxJob",
      input: { marker },
      captureOrigin,
    });

    expect(response.ok).toBe(true);

    const captured = await capture.waitForRequest({
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
  }, 30_000);
});

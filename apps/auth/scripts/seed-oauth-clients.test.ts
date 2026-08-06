import assert from "node:assert/strict";
import { test } from "node:test";
import { retryTransientOAuthSeed } from "./seed-oauth-clients.ts";

test("OAuth client seeding retries only transient Cloudflare propagation failures", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  const result = await retryTransientOAuthSeed(
    async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) throw { status: 522 };
      return "seeded";
    },
    {
      delaysMs: [10, 20],
      label: "preview OAuth client seed",
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(result, "seeded");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [10, 20]);
});

test("OAuth client seeding retries a bounded bootstrap-admin visibility delay", async () => {
  let attempts = 0;

  const result = await retryTransientOAuthSeed(
    async () => {
      attempts += 1;
      if (attempts === 1) throw { status: 503 };
      return "seeded";
    },
    {
      delaysMs: [10],
      label: "preview OAuth client seed",
      sleep: async () => undefined,
    },
  );

  assert.equal(result, "seeded");
  assert.equal(attempts, 2);
});

test("OAuth client seeding does not retry an unclassified server error", async () => {
  let attempts = 0;
  const error = { status: 500 };

  await assert.rejects(
    retryTransientOAuthSeed(
      async () => {
        attempts += 1;
        throw error;
      },
      {
        delaysMs: [10, 20],
        label: "preview OAuth client seed",
        sleep: async () => undefined,
      },
    ),
    (caught) => caught === error,
  );

  assert.equal(attempts, 1);
});

test("OAuth client seeding stops after its bounded propagation retry schedule", async () => {
  let attempts = 0;
  const error = { status: 522 };

  await assert.rejects(
    retryTransientOAuthSeed(
      async () => {
        attempts += 1;
        throw error;
      },
      {
        delaysMs: [10, 20],
        label: "preview OAuth client seed",
        sleep: async () => undefined,
      },
    ),
    (caught) => caught === error,
  );

  assert.equal(attempts, 3);
});

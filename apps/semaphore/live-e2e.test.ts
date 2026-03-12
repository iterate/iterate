import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createSemaphoreClient, type SemaphoreClient } from "@iterate-com/semaphore-contract";

const baseURL = process.env.SEMAPHORE_E2E_BASE_URL;
const apiKey = process.env.SEMAPHORE_E2E_API_TOKEN ?? process.env.SEMAPHORE_API_TOKEN;

function requireEnv() {
  if (!baseURL) {
    throw new Error("SEMAPHORE_E2E_BASE_URL is required for live E2E tests");
  }

  if (!apiKey) {
    throw new Error("SEMAPHORE_E2E_API_TOKEN (or SEMAPHORE_API_TOKEN) is required");
  }

  return { apiKey, baseURL };
}

function uniqueType() {
  return `live-e2e-${randomUUID().slice(0, 8)}`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseURL: string, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/health", baseURL));
      if (response.ok && (await response.text()) === "OK") {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for health at ${baseURL}`);
}

describe("live semaphore E2E", () => {
  let client: SemaphoreClient;
  const leasedResources: Array<{ type: string; slug: string; leaseId: string }> = [];
  const createdResources: Array<{ type: string; slug: string }> = [];

  async function cleanup() {
    for (const lease of leasedResources.splice(0).reverse()) {
      try {
        await client.resources.release(lease);
      } catch {
        // best-effort cleanup
      }
    }

    for (const resource of createdResources.splice(0).reverse()) {
      try {
        await client.resources.delete(resource);
      } catch {
        // best-effort cleanup
      }
    }
  }

  beforeAll(async () => {
    const env = requireEnv();
    await waitForHealth(env.baseURL, 30_000);
    await sleep(2_000);
    client = createSemaphoreClient(env);
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  test("can add, list, acquire, release, and delete resources", async () => {
    const type = uniqueType();

    const alpha = await client.resources.add({
      type,
      slug: "alpha",
      data: { token: "secret-alpha" },
    });
    createdResources.push({ type, slug: alpha.slug });

    const beta = await client.resources.add({
      type,
      slug: "beta",
      data: { token: "secret-beta" },
    });
    createdResources.push({ type, slug: beta.slug });

    const listed = await client.resources.list({ type });
    expect(listed.map((resource) => resource.slug)).toEqual(["alpha", "beta"]);

    const lease = await client.resources.acquire({
      type,
      leaseMs: 60_000,
    });
    leasedResources.push({ type, slug: lease.slug, leaseId: lease.leaseId });
    expect(lease.slug).toBe("alpha");

    const released = await client.resources.release({
      type,
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
    expect(released).toEqual({ released: true });
    leasedResources.splice(
      leasedResources.findIndex(
        (activeLease) =>
          activeLease.type === type &&
          activeLease.slug === lease.slug &&
          activeLease.leaseId === lease.leaseId,
      ),
      1,
    );

    expect(await client.resources.delete({ type, slug: "alpha" })).toEqual({ deleted: true });
    createdResources.splice(
      createdResources.findIndex((resource) => resource.type === type && resource.slug === "alpha"),
      1,
    );

    expect(await client.resources.delete({ type, slug: "beta" })).toEqual({ deleted: true });
    createdResources.splice(
      createdResources.findIndex((resource) => resource.type === type && resource.slug === "beta"),
      1,
    );
  });

  test("can wait for a lease and acquire it after release", async () => {
    const type = uniqueType();

    const created = await client.resources.add({
      type,
      slug: "only",
      data: { token: "secret-only" },
    });
    createdResources.push({ type, slug: created.slug });

    const firstLease = await client.resources.acquire({
      type,
      leaseMs: 60_000,
    });
    leasedResources.push({ type, slug: firstLease.slug, leaseId: firstLease.leaseId });

    const waitingLeasePromise = client.resources.acquire({
      type,
      leaseMs: 60_000,
      waitMs: 5_000,
    });

    await sleep(250);

    expect(
      await client.resources.release({
        type,
        slug: firstLease.slug,
        leaseId: firstLease.leaseId,
      }),
    ).toEqual({ released: true });
    leasedResources.splice(
      leasedResources.findIndex(
        (lease) =>
          lease.type === type &&
          lease.slug === firstLease.slug &&
          lease.leaseId === firstLease.leaseId,
      ),
      1,
    );

    const waitingLease = await waitingLeasePromise;
    leasedResources.push({ type, slug: waitingLease.slug, leaseId: waitingLease.leaseId });
    expect(waitingLease.slug).toBe("only");
  });
});

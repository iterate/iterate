import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createSemaphoreClient } from "../../src/contract.ts";
import {
  createSemaphoreAppFixture,
  requireSemaphoreBaseUrl,
  semaphoreApiTokenProvider,
  sleep,
  waitForHealth,
} from "../helpers.ts";

function uniqueType() {
  return `live-e2e-${randomUUID().slice(0, 8)}`;
}

const app = createSemaphoreAppFixture({
  apiKey: semaphoreApiTokenProvider(requireSemaphoreBaseUrl()),
  baseURL: requireSemaphoreBaseUrl(),
});

const semaphore = createSemaphoreClient({
  apiKey: app.apiKey,
  baseURL: app.baseURL,
});

describe.sequential("live semaphore E2E", () => {
  const leasedResources: Array<{ type: string; slug: string; leaseId: string }> = [];
  const createdResources: Array<{ type: string; slug: string }> = [];

  async function cleanup() {
    for (const lease of leasedResources.splice(0).reverse()) {
      try {
        await app.apiFetch("/api/resources/release", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(lease),
        });
      } catch {
        // best-effort cleanup
      }
    }

    for (const resource of createdResources.splice(0).reverse()) {
      try {
        await app.apiFetch(
          `/api/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.slug)}`,
          {
            method: "DELETE",
          },
        );
      } catch {
        // best-effort cleanup
      }
    }
  }

  beforeAll(async () => {
    await waitForHealth(app.baseURL, 30_000);
    await sleep(2_000);
  }, 120_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  test("rejects unauthenticated reads and mutations", async () => {
    const type = uniqueType();

    const list = await app.fetch(`/api/resources?type=${encodeURIComponent(type)}`);
    expect(list.ok).toBe(false);

    const create = await app.fetch("/api/resources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        slug: "alpha",
        data: { token: "secret-alpha" },
      }),
    });
    expect(create.ok).toBe(false);
  });

  test("can add, list, acquire, release, and delete resources", async () => {
    const type = uniqueType();

    const alpha = await apiJson<{ slug: string }>("/api/resources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        slug: "alpha",
        data: { token: "secret-alpha" },
      }),
    });
    createdResources.push({ type, slug: alpha.slug });

    const beta = await apiJson<{ slug: string }>("/api/resources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        slug: "beta",
        data: { token: "secret-beta" },
      }),
    });
    createdResources.push({ type, slug: beta.slug });

    const listed = await apiJson<
      Array<{ slug: string; leaseState: string; leasedUntil: number | null }>
    >(`/api/resources?type=${encodeURIComponent(type)}`, { method: "GET" });
    expect(listed.map((resource) => resource.slug)).toEqual(["alpha", "beta"]);
    expect(listed[0]?.leaseState).toBe("available");
    expect(listed[0]?.leasedUntil).toBeNull();

    const lease = await apiJson<{ slug: string; leaseId: string }>("/api/resources/acquire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        leaseMs: 60_000,
      }),
    });
    leasedResources.push({ type, slug: lease.slug, leaseId: lease.leaseId });
    expect(lease.slug).toBe("alpha");

    const leasedList = await apiJson<Array<{ leaseState: string; leasedUntil: number | null }>>(
      `/api/resources?type=${encodeURIComponent(type)}`,
      { method: "GET" },
    );
    expect(leasedList[0]?.leaseState).toBe("leased");
    expect(leasedList[0]?.leasedUntil).toEqual(expect.any(Number));

    const released = await apiJson<{ released: boolean }>("/api/resources/release", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        slug: lease.slug,
        leaseId: lease.leaseId,
      }),
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

    expect(
      await apiJson<{ deleted: boolean }>(
        `/api/resources/${encodeURIComponent(type)}/${encodeURIComponent("alpha")}`,
        { method: "DELETE" },
      ),
    ).toEqual({ deleted: true });
    createdResources.splice(
      createdResources.findIndex((resource) => resource.type === type && resource.slug === "alpha"),
      1,
    );

    expect(
      await apiJson<{ deleted: boolean }>(
        `/api/resources/${encodeURIComponent(type)}/${encodeURIComponent("beta")}`,
        { method: "DELETE" },
      ),
    ).toEqual({ deleted: true });
    createdResources.splice(
      createdResources.findIndex((resource) => resource.type === type && resource.slug === "beta"),
      1,
    );
  }, 120_000);

  test("can wait for a lease and acquire it after release", async () => {
    const type = uniqueType();

    const created = await apiJson<{ slug: string }>("/api/resources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        slug: "only",
        data: { token: "secret-only" },
      }),
    });
    createdResources.push({ type, slug: created.slug });

    const firstLease = await apiJson<{ slug: string; leaseId: string }>("/api/resources/acquire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        leaseMs: 60_000,
      }),
    });
    leasedResources.push({ type, slug: firstLease.slug, leaseId: firstLease.leaseId });

    const waitingLeasePromise = apiJson<{ slug: string; leaseId: string }>(
      "/api/resources/acquire",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type,
          leaseMs: 60_000,
          waitMs: 5_000,
        }),
      },
    );

    await sleep(250);

    expect(
      await apiJson<{ released: boolean }>("/api/resources/release", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type,
          slug: firstLease.slug,
          leaseId: firstLease.leaseId,
        }),
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
  }, 120_000);

  test("a waiter does not block capacity allowed for a later waiter", async () => {
    const type = uniqueType();
    for (const slug of ["alpha", "beta"]) {
      await semaphore.resources.add({ type, slug, data: { token: `secret-${slug}` } });
      createdResources.push({ type, slug });
    }

    const alphaLease = await semaphore.resources.acquireSpecific({
      type,
      slug: "alpha",
      leaseMs: 60_000,
    });
    const betaLease = await semaphore.resources.acquireSpecific({
      type,
      slug: "beta",
      leaseMs: 60_000,
    });
    expect(alphaLease).not.toBeNull();
    expect(betaLease).not.toBeNull();
    leasedResources.push(
      { type, slug: "alpha", leaseId: alphaLease!.leaseId },
      { type, slug: "beta", leaseId: betaLease!.leaseId },
    );

    const waitingForAlpha = semaphore.resources.acquire({
      type,
      leaseMs: 60_000,
      waitMs: 5_000,
      allowedSlugs: ["alpha"],
    });
    const waitingForBeta = semaphore.resources.acquire({
      type,
      leaseMs: 60_000,
      waitMs: 5_000,
      allowedSlugs: ["beta"],
    });
    // Attach rejection handlers to both concurrent requests immediately. If
    // one assertion/release fails, the sibling waiter can still reach its
    // bounded timeout; leaving it unobserved makes Vitest report an unhandled
    // rejection during the retry even when the retry itself passes.
    const waiterSettlements = Promise.allSettled([waitingForAlpha, waitingForBeta]);
    try {
      await sleep(250);

      await semaphore.resources.release({
        type,
        slug: "beta",
        leaseId: betaLease!.leaseId,
      });
      leasedResources.splice(
        leasedResources.findIndex((lease) => lease.leaseId === betaLease!.leaseId),
        1,
      );
      const reassignedBeta = await waitingForBeta;
      leasedResources.push({ type, slug: "beta", leaseId: reassignedBeta.leaseId });
      expect(reassignedBeta.slug).toBe("beta");

      await semaphore.resources.release({
        type,
        slug: "alpha",
        leaseId: alphaLease!.leaseId,
      });
      leasedResources.splice(
        leasedResources.findIndex((lease) => lease.leaseId === alphaLease!.leaseId),
        1,
      );
      const reassignedAlpha = await waitingForAlpha;
      leasedResources.push({ type, slug: "alpha", leaseId: reassignedAlpha.leaseId });
      expect(reassignedAlpha.slug).toBe("alpha");
    } finally {
      await waiterSettlements;
    }
  }, 120_000);

  test("records the lease holder and honors force acquire/release", async () => {
    const type = uniqueType();
    const created = await semaphore.resources.add({
      type,
      slug: "contested",
      data: { token: "secret-contested" },
    });
    createdResources.push({ type, slug: created.slug });

    const lease = await semaphore.resources.acquireSpecific({
      type,
      slug: "contested",
      leaseMs: 60_000,
      holder: "pr-1600",
    });
    expect(lease).not.toBeNull();
    leasedResources.push({ type, slug: "contested", leaseId: lease!.leaseId });
    expect(lease!.holder).toBe("pr-1600");

    const listed = await semaphore.resources.list({ type });
    expect(listed[0]).toMatchObject({ leaseState: "leased", holder: "pr-1600" });

    // Without force the held slug stays held.
    expect(
      await semaphore.resources.acquireSpecific({
        type,
        slug: "contested",
        leaseMs: 60_000,
        holder: "pr-1601",
      }),
    ).toBeNull();

    // Force evicts and records the new holder.
    const stolen = await semaphore.resources.acquireSpecific({
      type,
      slug: "contested",
      leaseMs: 60_000,
      holder: "pr-1601",
      force: true,
    });
    expect(stolen).not.toBeNull();
    leasedResources.push({ type, slug: "contested", leaseId: stolen!.leaseId });
    expect(stolen!.holder).toBe("pr-1601");

    // The evicted lease id no longer releases; force does.
    expect(
      await semaphore.resources.release({ type, slug: "contested", leaseId: lease!.leaseId }),
    ).toEqual({ released: false });
    expect(await semaphore.resources.release({ type, slug: "contested", force: true })).toEqual({
      released: true,
    });

    const releasedList = await semaphore.resources.list({ type });
    expect(releasedList[0]).toMatchObject({ leaseState: "available", holder: null });
  }, 120_000);

  test("specific acquisition stays inside the caller's allowed slugs", async () => {
    const type = uniqueType();
    for (const slug of ["alpha", "beta"]) {
      await semaphore.resources.add({ type, slug, data: { token: `secret-${slug}` } });
      createdResources.push({ type, slug });
    }

    expect(
      await semaphore.resources.acquireSpecific({
        type,
        slug: "beta",
        leaseMs: 60_000,
        allowedSlugs: ["alpha"],
      }),
    ).toBeNull();

    const lease = await semaphore.resources.acquireSpecific({
      type,
      slug: "beta",
      leaseMs: 60_000,
      allowedSlugs: ["beta"],
    });
    expect(lease).not.toBeNull();
    leasedResources.push({ type, slug: lease!.slug, leaseId: lease!.leaseId });
  }, 120_000);

  test("hands out the least recently released resource first", async () => {
    const type = uniqueType();
    for (const slug of ["alpha", "beta"]) {
      await semaphore.resources.add({ type, slug, data: { token: `secret-${slug}` } });
      createdResources.push({ type, slug });
    }

    // alpha goes out first (never-released tie broken by creation order)...
    const first = await semaphore.resources.acquire({ type, leaseMs: 60_000 });
    expect(first.slug).toBe("alpha");
    await semaphore.resources.release({ type, slug: first.slug, leaseId: first.leaseId });

    // ...but once alpha has been released, never-used beta is preferred over
    // immediately re-issuing alpha.
    const second = await semaphore.resources.acquire({ type, leaseMs: 60_000 });
    expect(second.slug).toBe("beta");

    const third = await semaphore.resources.acquire({ type, leaseMs: 60_000 });
    expect(third.slug).toBe("alpha");

    // Release beta before alpha: beta is now the least recently released.
    await semaphore.resources.release({ type, slug: "beta", leaseId: second.leaseId });
    await sleep(5);
    await semaphore.resources.release({ type, slug: "alpha", leaseId: third.leaseId });

    const fourth = await semaphore.resources.acquire({ type, leaseMs: 60_000 });
    leasedResources.push({ type, slug: fourth.slug, leaseId: fourth.leaseId });
    expect(fourth.slug).toBe("beta");
  }, 120_000);

  test("acquires only from the caller's allowed slugs", async () => {
    const type = uniqueType();
    for (const slug of ["alpha", "beta", "gamma"]) {
      await semaphore.resources.add({ type, slug, data: { token: `secret-${slug}` } });
      createdResources.push({ type, slug });
    }

    const lease = await semaphore.resources.acquire({
      type,
      leaseMs: 60_000,
      allowedSlugs: ["beta", "gamma"],
    });
    leasedResources.push({ type, slug: lease.slug, leaseId: lease.leaseId });

    expect(lease.slug).toBe("beta");
  }, 120_000);

  test("supports the contract client against the live worker", async () => {
    const type = uniqueType();
    const created = await semaphore.resources.add({
      type,
      slug: "client-alpha",
      data: { token: "secret-client" },
    });
    createdResources.push({ type, slug: created.slug });

    expect(created.slug).toBe("client-alpha");

    const listed = await semaphore.resources.list({ type });
    expect(listed).toEqual([
      expect.objectContaining({
        slug: "client-alpha",
        data: { token: "secret-client" },
      }),
    ]);
  });
});

async function apiJson<T>(pathname: string, init: RequestInit) {
  const response = await app.apiFetch(pathname, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `${init.method ?? "GET"} ${pathname} failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}

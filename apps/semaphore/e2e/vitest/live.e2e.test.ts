import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  createSemaphoreAppFixture,
  requireSemaphoreApiToken,
  requireSemaphoreBaseUrl,
  sleep,
  waitForHealth,
} from "../helpers.ts";

function uniqueType() {
  return `live-e2e-${randomUUID().slice(0, 8)}`;
}

const app = createSemaphoreAppFixture({
  apiKey: requireSemaphoreApiToken(),
  baseURL: requireSemaphoreBaseUrl(),
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
});

async function apiJson<T>(pathname: string, init: RequestInit) {
  const response = await app.apiFetch(pathname, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(body || `${init.method ?? "GET"} ${pathname} failed with ${response.status}`);
  }

  return JSON.parse(body) as T;
}

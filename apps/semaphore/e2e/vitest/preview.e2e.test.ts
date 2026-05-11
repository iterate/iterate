import { randomUUID } from "node:crypto";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  createSemaphoreAppFixture,
  requireSemaphoreApiToken,
  requireSemaphoreBaseUrl,
  sleep,
  waitForHealth,
} from "../helpers.ts";

function uniqueType() {
  return `preview-e2e-${randomUUID().slice(0, 8)}`;
}

const app = createSemaphoreAppFixture({
  apiKey: requireSemaphoreApiToken(),
  baseURL: requireSemaphoreBaseUrl(),
});

const semaphore = createSemaphoreClient({
  apiKey: app.apiKey,
  baseURL: app.baseURL,
});

describe.sequential("preview semaphore E2E", () => {
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

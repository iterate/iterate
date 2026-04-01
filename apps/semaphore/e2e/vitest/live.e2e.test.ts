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
  return `live-e2e-${randomUUID().slice(0, 8)}`;
}

function uniquePullRequestNumber() {
  return Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
}

const app = createSemaphoreAppFixture({
  apiKey: requireSemaphoreApiToken(),
  baseURL: requireSemaphoreBaseUrl(),
});

const semaphore = createSemaphoreClient({
  apiKey: app.apiKey,
  baseURL: app.baseURL,
});

describe.sequential("live semaphore E2E", () => {
  const leasedResources: Array<{ type: string; slug: string; leaseId: string }> = [];
  const createdResources: Array<{ type: string; slug: string }> = [];
  const leasedPreviewEnvironments: Array<{
    previewEnvironmentIdentifier: string;
    previewEnvironmentSemaphoreLeaseId: string;
  }> = [];

  async function cleanup() {
    for (const previewEnvironment of leasedPreviewEnvironments.splice(0).reverse()) {
      try {
        await semaphore.preview.destroy({
          previewEnvironmentIdentifier: previewEnvironment.previewEnvironmentIdentifier,
          previewEnvironmentSemaphoreLeaseId: previewEnvironment.previewEnvironmentSemaphoreLeaseId,
          destroyReason: "vitest-cleanup",
        });
      } catch {
        // best-effort cleanup
      }
    }

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

  test("can create, reuse, list, and destroy preview environments", async () => {
    const pullRequestNumber = uniquePullRequestNumber();

    const ensured = await semaphore.preview.ensureInventory({});
    expect(ensured.upsertedCount).toBeGreaterThanOrEqual(40);

    const created = await semaphore.preview.create({
      previewEnvironmentAppSlug: "semaphore",
      repositoryFullName: "iterate/iterate",
      pullRequestNumber,
      pullRequestHeadRefName: `feature/${pullRequestNumber}`,
      pullRequestHeadSha: randomUUID().replaceAll("-", ""),
      workflowRunUrl: "https://github.com/iterate/iterate/actions/runs/1",
      leaseMs: 60_000,
    });

    expect(created.previewEnvironmentIdentifier).toMatch(/^semaphore-preview-\d+$/);
    expect(created.previewEnvironmentDopplerConfigName).toMatch(/^stg_\d+$/);
    expect(created.previewEnvironmentAlchemyStageName).toMatch(/^preview-\d+$/);
    expect(created.previewEnvironmentSemaphoreLeaseId).toEqual(expect.any(String));
    leasedPreviewEnvironments.push({
      previewEnvironmentIdentifier: created.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: created.previewEnvironmentSemaphoreLeaseId!,
    });

    const renewed = await semaphore.preview.create({
      previewEnvironmentAppSlug: "semaphore",
      repositoryFullName: "iterate/iterate",
      pullRequestNumber,
      pullRequestHeadRefName: `feature/${pullRequestNumber}`,
      pullRequestHeadSha: randomUUID().replaceAll("-", ""),
      workflowRunUrl: "https://github.com/iterate/iterate/actions/runs/2",
      leaseMs: 60_000,
    });

    expect(renewed.previewEnvironmentIdentifier).toBe(created.previewEnvironmentIdentifier);
    expect(renewed.previewEnvironmentSemaphoreLeaseId).toBe(
      created.previewEnvironmentSemaphoreLeaseId,
    );

    const listed = await semaphore.preview.list({
      repositoryFullName: "iterate/iterate",
      pullRequestNumber,
      previewEnvironmentAppSlug: "semaphore",
    });

    expect(listed).toEqual([
      expect.objectContaining({
        previewEnvironmentIdentifier: created.previewEnvironmentIdentifier,
        previewEnvironmentLeaseOwner: expect.objectContaining({
          pullRequestNumber,
        }),
      }),
    ]);

    const destroyed = await semaphore.preview.destroy({
      previewEnvironmentIdentifier: created.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: created.previewEnvironmentSemaphoreLeaseId!,
      destroyReason: "test-cleanup",
    });

    expect(destroyed).toEqual({ destroyed: true });
    leasedPreviewEnvironments.splice(
      leasedPreviewEnvironments.findIndex(
        (previewEnvironment) =>
          previewEnvironment.previewEnvironmentIdentifier ===
            created.previewEnvironmentIdentifier &&
          previewEnvironment.previewEnvironmentSemaphoreLeaseId ===
            created.previewEnvironmentSemaphoreLeaseId,
      ),
      1,
    );

    const releasedPreview = await semaphore.preview.get({
      previewEnvironmentIdentifier: created.previewEnvironmentIdentifier,
    });
    expect(releasedPreview.previewEnvironmentSemaphoreLeaseId).toBeNull();
    expect(releasedPreview.previewEnvironmentLeaseOwner).toBeNull();
    expect(releasedPreview.leaseState).toBe("available");
  }, 120_000);

  test("does not destroy a preview when the SemaphoreLeaseId is stale", async () => {
    const firstPullRequestNumber = uniquePullRequestNumber();
    const secondPullRequestNumber = uniquePullRequestNumber();

    await semaphore.preview.ensureInventory({});

    const first = await semaphore.preview.create({
      previewEnvironmentAppSlug: "semaphore",
      repositoryFullName: "iterate/iterate",
      pullRequestNumber: firstPullRequestNumber,
      pullRequestHeadRefName: `feature/${firstPullRequestNumber}`,
      pullRequestHeadSha: randomUUID().replaceAll("-", ""),
      workflowRunUrl: "https://github.com/iterate/iterate/actions/runs/3",
      leaseMs: 10,
    });

    expect(first.previewEnvironmentSemaphoreLeaseId).toEqual(expect.any(String));
    await sleep(25);

    const replacement = await semaphore.preview.create({
      previewEnvironmentAppSlug: "semaphore",
      repositoryFullName: "iterate/iterate",
      pullRequestNumber: secondPullRequestNumber,
      pullRequestHeadRefName: `feature/${secondPullRequestNumber}`,
      pullRequestHeadSha: randomUUID().replaceAll("-", ""),
      workflowRunUrl: "https://github.com/iterate/iterate/actions/runs/4",
      leaseMs: 60_000,
      previewEnvironmentIdentifier: first.previewEnvironmentIdentifier,
    });

    expect(replacement.previewEnvironmentSemaphoreLeaseId).toEqual(expect.any(String));
    expect(replacement.previewEnvironmentSemaphoreLeaseId).not.toBe(
      first.previewEnvironmentSemaphoreLeaseId,
    );
    leasedPreviewEnvironments.push({
      previewEnvironmentIdentifier: replacement.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: replacement.previewEnvironmentSemaphoreLeaseId!,
    });

    const destroyed = await semaphore.preview.destroy({
      previewEnvironmentIdentifier: first.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: first.previewEnvironmentSemaphoreLeaseId!,
      destroyReason: "stale-cleanup",
    });

    expect(destroyed).toEqual({ destroyed: false });

    const current = await semaphore.preview.get({
      previewEnvironmentIdentifier: replacement.previewEnvironmentIdentifier,
    });

    expect(current.previewEnvironmentSemaphoreLeaseId).toBe(
      replacement.previewEnvironmentSemaphoreLeaseId,
    );
    expect(current.previewEnvironmentLeaseOwner).toMatchObject({
      pullRequestNumber: secondPullRequestNumber,
    });
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

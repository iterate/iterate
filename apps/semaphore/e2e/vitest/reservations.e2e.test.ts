import { expect, test } from "vitest";
import { createSemaphoreClient } from "../../src/contract.ts";
import {
  createSemaphoreAppFixture,
  requireSemaphoreBaseUrl,
  semaphoreApiTokenProvider,
} from "../helpers.ts";

test("old PR clients cannot acquire main's slot, even with force; main cannot take PR slots", async () => {
  const baseURL = requireSemaphoreBaseUrl();
  // This test owns fixed inventory names. Production's real preview leases
  // must never be used as a test fixture.
  expect(new URL(baseURL).hostname).toMatch(/^semaphore\.iterate-preview-\d+\.com$/);
  const app = createSemaphoreAppFixture({ apiKey: semaphoreApiTokenProvider(baseURL), baseURL });
  const resources = createSemaphoreClient({
    apiKey: app.apiKey,
    baseURL,
    fetch: app.networkFetch,
  }).resources;
  const type = "environment-config-lease";
  expect(await resources.list({ type })).toEqual([]);
  const created: string[] = [];
  const leases: Array<{ type: string; slug: string; leaseId: string }> = [];
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      for (const lease of leases.toReversed()) await resources.release(lease);
      for (const slug of created.toReversed()) await resources.delete({ type, slug });
    },
  };
  for (const slug of ["preview-1", "preview-2"]) {
    await resources.add({ type, slug, data: {} });
    created.push(slug);
  }
  expect(await resources.policy({ type })).toMatchObject({
    reservations: [{ slug: "preview-1", holder: "main-preview" }],
  });
  const main = await resources.acquire({ type, holder: "main-preview", leaseMs: 60_000 });
  leases.push(main);
  expect(main).toMatchObject({ slug: "preview-1", holder: "main-preview" });
  expect(
    await resources.acquireSpecific({
      type,
      slug: "preview-1",
      holder: "pr-old",
      force: true,
      leaseMs: 60_000,
      allowedSlugs: ["preview-1", "preview-2"],
    }),
  ).toBeNull();
  expect(
    await resources.acquireSpecific({
      type,
      slug: "preview-2",
      holder: "main-preview",
      force: true,
      leaseMs: 60_000,
    }),
  ).toBeNull();
  const pr = await resources.acquire({ type, holder: "pr-old", leaseMs: 60_000 });
  leases.push(pr);
  expect(pr).toMatchObject({ slug: "preview-2", holder: "pr-old" });
  expect(
    await resources.acquireSpecific({
      type,
      slug: "preview-1",
      holder: "gc",
      force: true,
      leaseMs: 60_000,
    }),
  ).toBeNull();
  await resources.release(main);
  expect(
    await resources.acquireSpecific({ type, slug: "preview-1", holder: "pr-old", leaseMs: 60_000 }),
  ).toBeNull();
  const maintenance = await resources.acquireSpecific({
    type,
    slug: "preview-1",
    holder: "gc",
    leaseMs: 60_000,
  });
  expect(maintenance).toMatchObject({ holder: "gc" });
  leases.push(maintenance!);
  expect(
    await resources.acquireSpecific({
      type,
      slug: "preview-1",
      holder: "main-preview",
      leaseMs: 60_000,
    }),
  ).toBeNull();
});

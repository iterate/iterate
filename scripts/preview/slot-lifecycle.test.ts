import { expect, test } from "vitest";
import { preparedPreviewSlot, previewSlotRestMs } from "./slot-lifecycle.ts";
import { previewInternals, type PreviewSemaphoreResourceClient } from "./preview.ts";

test("only a completed rest under the current policy allows skipping the rollout wait", () => {
  const parkedAt = 1_000_000;
  const readyAt = parkedAt + previewSlotRestMs;
  const tags = {
    "preview-policy": "parked-v1",
    "preview-parked-at": String(parkedAt),
    "preview-ready-at": String(readyAt),
  };
  expect(preparedPreviewSlot(tags, readyAt)).toMatchObject({ "preview-ready-at": readyAt });
  for (const invalid of [
    undefined,
    {},
    { ...tags, "preview-policy": "old" },
    { ...tags, "preview-ready-at": String(readyAt - 1) },
  ]) {
    expect(preparedPreviewSlot(invalid, readyAt)).toBeNull();
  }
  expect(preparedPreviewSlot(tags, readyAt - 1)).toBeNull();
});

test("retirement keeps both leases until the old slot has finished resting", async () => {
  const pool = new SlotPool();
  const events: string[] = [];
  expect(
    await previewInternals.retirePreviewSlots({
      semaphore: pool,
      holder: "pr-123",
      keepSlot: "preview-2",
      eraseSlotData: async ({ slug }) => {
        events.push(`park ${slug}`);
      },
      rest: async () => {
        expect(events).toEqual(["park preview-1"]);
        expect(pool.held).toEqual(["preview-1", "preview-2"]);
        events.push("rest complete");
      },
    }),
  ).toMatchObject({ retired: ["preview-1"] });
  expect(pool).toMatchObject({
    held: ["preview-2"],
    released: [{ slug: "preview-1", tags: { "preview-policy": "parked-v1" } }],
  });
});

test("an interrupted rest releases no preparation and leaves the published preview alone", async () => {
  const pool = new SlotPool();
  await expect(
    previewInternals.retirePreviewSlots({
      semaphore: pool,
      holder: "pr-123",
      keepSlot: "preview-2",
      eraseSlotData: async () => {},
      rest: async () => {
        throw new Error("cancelled");
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(pool).toMatchObject({ held: ["preview-2"], released: [{ slug: "preview-1", tags: {} }] });
});

test.each([true, false])(
  "acquisition rechecks preparation returned by Semaphore (still prepared: %s)",
  async (stillPrepared) => {
    const tags = {
      "preview-policy": "parked-v1",
      "preview-parked-at": "1000000",
      "preview-ready-at": "1150000",
    };
    const events: string[] = [];
    const lease = {
      type: "environment-config-lease",
      slug: "preview-3",
      data: { dopplerConfig: "preview_3" },
      leaseId: "next-token",
      expiresAt: Date.now() + 60_000,
      tags: stillPrepared ? tags : {},
    };
    const semaphore: PreviewSemaphoreResourceClient = {
      list: async () => [
        {
          ...lease,
          tags: { ...tags, "preview-ready-at": "1250000" },
          slug: "preview-4",
          leaseState: "available",
          leasedUntil: null,
          lastAcquiredAt: null,
          lastReleasedAt: null,
        },
        {
          ...lease,
          tags,
          leaseState: "available",
          leasedUntil: null,
          lastAcquiredAt: null,
          lastReleasedAt: null,
        },
      ],
      acquireSpecific: async (input) => {
        events.push(`acquire ${input.slug}`);
        return lease;
      },
      acquire: async () => {
        throw new Error("Should prefer prepared slots");
      },
      release: async () => ({ released: true }),
    };
    await previewInternals.acquireAnyEnvironmentConfigLease({
      semaphore,
      holder: "pr-123",
      leaseMs: 60_000,
      waitTotalMs: 0,
      eraseSlotData: async ({ slug }) => {
        events.push(`erase ${slug}`);
      },
    });
    expect(events).toEqual(
      stillPrepared ? ["acquire preview-3"] : ["acquire preview-3", "erase preview-3"],
    );
  },
);

test("an explicit erase invalidates preparation even when acquisition returned tags", async () => {
  const pool = new SlotPool();
  const lease = {
    type: "environment-config-lease",
    slug: "preview-3",
    data: { dopplerConfig: "preview_3" },
    leaseId: "current-token",
    tags: {
      "preview-policy": "parked-v1",
      "preview-parked-at": "1000000",
      "preview-ready-at": "1150000",
    },
  };
  expect(
    await previewInternals.eraseAcquiredSlotOrGiveItBack({
      semaphore: pool,
      lease,
      eraseSlotData: async () => {},
    }),
  ).toBe(true);
  expect(preparedPreviewSlot(lease.tags, Date.now())).toBeNull();
});

/** Small controllable pool; Semaphore's HTTP integration tests cover the lease arbitration. */
class SlotPool implements PreviewSemaphoreResourceClient {
  held = ["preview-1", "preview-2"];
  released: any[] = [];
  async list() {
    return this.held.map((slug) => ({
      slug,
      data: { dopplerConfig: slug.replace("-", "_") },
      holder: "pr-123",
      leaseState: "leased" as const,
      leasedUntil: Date.now() + 60_000,
      lastAcquiredAt: null,
      lastReleasedAt: null,
    }));
  }
  async acquire(): Promise<never> {
    throw new Error("Retirement must not take a free slot");
  }
  async acquireSpecific(input: any) {
    expect(input).toMatchObject({ expectedHolder: "pr-123" });
    expect(this.held).toContain(input.slug);
    return {
      ...input,
      data: { dopplerConfig: input.slug.replace("-", "_") },
      leaseId: "current-token",
      expiresAt: Date.now() + input.leaseMs,
    };
  }
  async release(input: any) {
    expect(input).toMatchObject({ leaseId: "current-token" });
    this.held = this.held.filter((slug) => slug !== input.slug);
    this.released.push(input);
    return { released: true };
  }
}

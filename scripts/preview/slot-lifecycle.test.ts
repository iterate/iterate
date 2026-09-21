import { expect, test } from "vitest";
import { previewInternals, type PreviewSemaphoreResourceClient } from "./preview.ts";

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
    released: [{ slug: "preview-1", tags: { "preview-state": "rested" } }],
  });
});

test.each(["erase", "rest"])(
  "interrupted %s releases no preparation and leaves the published preview alone",
  async (stage) => {
    const pool = new SlotPool();
    await expect(
      previewInternals.retirePreviewSlots({
        semaphore: pool,
        holder: "pr-123",
        keepSlot: "preview-2",
        eraseSlotData: async () => {
          if (stage === "erase") throw new Error("cancelled");
        },
        rest: async () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(pool).toMatchObject({
      held: ["preview-2"],
      released: [{ slug: "preview-1", tags: {} }],
    });
  },
);

test.each(["rested", "parked", undefined])(
  "acquisition skips erase only when the acquired lease is rested (state: %s)",
  async (state) => {
    const events: string[] = [];
    const semaphore: PreviewSemaphoreResourceClient = {
      list: async () => {
        throw new Error("Semaphore chooses the preferred slot atomically");
      },
      acquireSpecific: async () => {
        throw new Error("Use preference-based acquisition");
      },
      acquire: async (input) => {
        expect(input).toMatchObject({ preferredTags: { "preview-state": "rested" } });
        events.push("acquire preview-3");
        return {
          type: "environment-config-lease",
          slug: "preview-3",
          data: { dopplerConfig: "preview_3" },
          leaseId: "next-token",
          expiresAt: Date.now() + 60_000,
          tags: state ? { "preview-state": state } : undefined,
        };
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
      state === "rested" ? ["acquire preview-3"] : ["acquire preview-3", "erase preview-3"],
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
    tags: { "preview-state": "rested" },
  };
  expect(
    await previewInternals.eraseAcquiredSlotOrGiveItBack({
      semaphore: pool,
      lease,
      eraseSlotData: async () => {},
    }),
  ).toBe(true);
  expect(lease).not.toHaveProperty("tags");
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

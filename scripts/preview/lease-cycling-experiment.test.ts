import { expect, test } from "vitest";
import { claimRestedExperimentSlot, readLeaseCyclingReceipt } from "./lease-cycling-experiment.ts";

test("the zero-gate receipt is accepted only on the explicitly opted-in experiment branch", () => {
  const receipt = { slug: "preview-4", parkedAt: 1_000, releasedAt: 151_000 };
  expect(readLeaseCyclingReceipt({})).toBeNull();
  expect(
    readLeaseCyclingReceipt({
      GITHUB_REF_NAME: "codex/experiment-preview-lease-cycling",
      PREVIEW_LEASE_CYCLING_RECEIPT: JSON.stringify(receipt),
    }),
  ).toEqual(receipt);
  expect(() =>
    readLeaseCyclingReceipt({
      GITHUB_REF_NAME: "main",
      PREVIEW_LEASE_CYCLING_RECEIPT: JSON.stringify(receipt),
    }),
  ).toThrow(/experiment branch/);
});

test("a rested available slot is claimed without another erase while retaining its release proof", async () => {
  const fixture = slotPool();
  const lease = await claimRestedExperimentSlot(fixture.input);
  expect({ lease, actions: fixture.actions }).toMatchObject({
    lease: { slug: "preview-4", holder: "lease-cycling-run" },
    actions: ["claim", "verify parked"],
  });
});

test.each(["released by someone else", "not rested", "already leased"])(
  "rejects %s before claiming",
  async (fault) => {
    const fixture = slotPool();
    if (fault === "released by someone else") fixture.resource.lastReleasedAt++;
    if (fault === "not rested") fixture.input.now = 150_000;
    if (fault === "already leased") fixture.resource.leaseState = "leased";
    await expect(claimRestedExperimentSlot(fixture.input)).rejects.toThrow();
    expect(fixture.actions).toEqual([]);
  },
);

test("a release race invalidates the receipt after acquisition and returns only our lease", async () => {
  const fixture = slotPool();
  fixture.race = true;
  await expect(claimRestedExperimentSlot(fixture.input)).rejects.toThrow(/release/);
  expect(fixture.actions).toEqual(["claim", "release our lease"]);
});

test("failed live parked-state verification never permits zero-gate deployment", async () => {
  const fixture = slotPool();
  fixture.input.verifyParked = async () => {
    throw new Error("worker is live");
  };
  await expect(claimRestedExperimentSlot(fixture.input)).rejects.toThrow(/worker is live/);
  expect(fixture.actions).toEqual(["claim", "release our lease"]);
});

function slotPool() {
  const actions: string[] = [];
  const resource = {
    slug: "preview-4",
    leaseState: "available",
    holder: null as string | null,
    lastReleasedAt: 151_000,
  };
  const fixture = {
    actions,
    resource,
    race: false,
    input: {
      receipt: { slug: "preview-4", parkedAt: 1_000, releasedAt: 151_000 },
      holder: "lease-cycling-run",
      leaseMs: 600_000,
      now: 200_000,
      semaphore: {
        list: async () => [{ ...resource }],
        acquireSpecific: async (input: any) => {
          expect(input.force).toBeUndefined();
          actions.push("claim");
          resource.leaseState = "leased";
          resource.holder = input.holder;
          if (fixture.race) resource.lastReleasedAt++;
          return {
            ...input,
            leaseId: "our-token",
            expiresAt: 800_000,
            data: { dopplerConfig: "preview_4" },
          };
        },
        release: async (input: any) => {
          expect(input).toMatchObject({ slug: "preview-4", leaseId: "our-token" });
          actions.push("release our lease");
          return { released: true };
        },
      } as any,
      verifyParked: async () => {
        actions.push("verify parked");
      },
    },
  };
  return fixture;
}

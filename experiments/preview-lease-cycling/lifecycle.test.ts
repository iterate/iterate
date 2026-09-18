import { expect, test } from "vitest";
import { replacePreview, retirePreview, releasedCleanup } from "./lifecycle.ts";

test("a failed replacement leaves the published preview usable and retires only the candidate", async () => {
  const events: string[] = [];
  const runtime = {
    acquire: async () => "B",
    deploy: async () => {
      throw new Error("build failed");
    },
    publish: async () => {
      events.push("publish B");
      return { accepted: true, previous: "A" };
    },
    scheduleCleanup: async (slot: string) => {
      events.push(`cleanup ${slot}`);
    },
  };
  await expect(replacePreview(runtime)).rejects.toThrow("build failed");
  expect(events).toEqual(["cleanup B"]);
});

test("publication happens after readiness; cleanup runs independently of replacement green", async () => {
  const events: string[] = [];
  await expect(
    replacePreview({
      acquire: async () => {
        events.push("lease B, keep A");
        return "B";
      },
      deploy: async () => {
        events.push("B ready");
      },
      publish: async () => {
        events.push("publish B");
        return { accepted: true, previous: "A" };
      },
      scheduleCleanup: async (slot) => {
        events.push(`enqueue ${slot}`);
      },
    }),
  ).resolves.toMatchObject({ accepted: true, candidate: "B" });
  expect(events).toEqual(["lease B, keep A", "B ready", "publish B", "enqueue A"]);
});

test("a superseded build retires itself, never the newer published preview", async () => {
  const events: string[] = [];
  await expect(
    replacePreview({
      acquire: async () => "B",
      deploy: async () => {
        events.push("C became current while B deployed");
      },
      publish: async () => ({ accepted: false, previous: "C" }),
      scheduleCleanup: async (slot) => {
        events.push(`cleanup ${slot}`);
      },
    }),
  ).resolves.toMatchObject({ accepted: false, candidate: "B" });
  expect(events).toEqual(["C became current while B deployed", "cleanup B"]);
});

test("a cleanup scheduling failure cannot lobotomise the new published preview", async () => {
  const cleaned: string[] = [];
  await expect(
    replacePreview({
      acquire: async () => "B",
      deploy: async () => {},
      publish: async () => ({ accepted: true, previous: "A" }),
      scheduleCleanup: async (slot) => {
        cleaned.push(slot);
        throw new Error("job launch failed");
      },
    }),
  ).rejects.toThrow("job launch failed");
  expect(cleaned).toEqual(["A"]);
});

test("pool exhaustion leaves the old preview untouched", async () => {
  await expect(
    replacePreview({
      acquire: async () => {
        throw new Error("pool busy");
      },
      deploy: async () => {
        throw new Error("must not deploy");
      },
      publish: async () => {
        throw new Error("must not publish");
      },
      scheduleCleanup: async () => {
        throw new Error("must not clean");
      },
    }),
  ).rejects.toThrow("pool busy");
});

test("cleanup holds its lease through both waits and releases only after verification", async () => {
  const events: string[] = [];
  await retirePreview({
    assertOwned: async () => {
      events.push("owned");
    },
    park: async () => {
      events.push("park");
    },
    waitAfterPark: async () => {
      events.push("wait parked");
    },
    remove: async () => {
      events.push("delete");
    },
    waitAfterRemoval: async () => {
      events.push("wait deleted");
    },
    verifyRemoved: async () => {
      events.push("verify absent");
    },
    release: async () => {
      events.push("release");
    },
  });
  expect(events).toEqual([
    "owned",
    "park",
    "wait parked",
    "owned",
    "delete",
    "wait deleted",
    "owned",
    "verify absent",
    "release",
  ]);
});

test.each(["park", "waitAfterPark", "remove", "waitAfterRemoval", "verifyRemoved"])(
  "failed %s leaves the lease held and never certifies cleanliness",
  async (failure) => {
    const events: string[] = [];
    const step = (name: string) => async () => {
      events.push(name);
      if (failure === name) throw new Error(failure);
    };
    await expect(
      retirePreview({
        assertOwned: step("assertOwned"),
        park: step("park"),
        waitAfterPark: step("waitAfterPark"),
        remove: step("remove"),
        waitAfterRemoval: step("waitAfterRemoval"),
        verifyRemoved: step("verifyRemoved"),
        release: step("release"),
      }),
    ).rejects.toThrow(failure);
    expect(events).not.toContain("release");
  },
);

test("losing ownership during cooling refuses deletion and release", async () => {
  const events: string[] = [];
  let checks = 0;
  await expect(
    retirePreview({
      assertOwned: async () => {
        if (++checks === 2) throw new Error("lease expired");
      },
      park: async () => {
        events.push("park");
      },
      waitAfterPark: async () => {
        events.push("wait");
      },
      remove: async () => {
        events.push("delete");
      },
      waitAfterRemoval: async () => {},
      verifyRemoved: async () => {},
      release: async () => {
        events.push("release");
      },
    }),
  ).rejects.toThrow("lease expired");
  expect(events).toEqual(["park", "wait"]);
});

test("a renewed cleanup lease still has a valid release receipt", () => {
  expect(
    releasedCleanup({ stage: "released", deletedAt: 100, releasedAt: 400 }, 400, 400),
  ).toMatchObject({ completedAt: 100, releasedAt: 400 });
});

test("a lease taken and released between selection and acquisition invalidates cleanup evidence", () => {
  expect(
    releasedCleanup({ stage: "released", deletedAt: 100, releasedAt: 400 }, 400, 900),
  ).toBeNull();
});

import { expect, test, vi } from "vitest";
import { BackgroundClaims } from "./background-claims.ts";

test("claims stay ordered after a rejection, so an old release cannot erase later work", async () => {
  const landed: (number | null)[] = [];
  const reported: unknown[] = [];
  let releaseFirst!: () => void;
  const claims = new BackgroundClaims({
    claim: async (at) => {
      if (at === null) await new Promise<void>((resolve) => (releaseFirst = resolve));
      if (at === 10) throw new Error("claim unavailable");
      landed.push(at);
    },
    report: (error) => reported.push(error),
    afterMs: 20,
    maxAfterMs: 80,
  });

  claims.at(null);
  claims.at(10);
  claims.at(20);
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
  releaseFirst();
  await vi.waitFor(() => expect(landed).toEqual([null, 20]));
  expect(reported).toHaveLength(1);
});

test("first work claims, last work releases, and a busy revive backs off then resets", async () => {
  vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
  try {
    const landed: (number | null)[] = [];
    const claims = new BackgroundClaims({
      claim: async (at) => {
        landed.push(at);
      },
      report: () => {},
      afterMs: 20,
      maxAfterMs: 80,
    });

    claims.started();
    await vi.waitFor(() => expect(landed).toEqual([1_020]));
    const revivedAt = Date.now();
    await claims.revivedWhileBusy();
    expect(landed).toEqual([1_020, revivedAt + 40]);
    claims.settled();
    await vi.waitFor(() => expect(landed).toEqual([1_020, revivedAt + 40, null]));
    const restartedAt = Date.now();
    claims.started();
    await vi.waitFor(() => expect(landed).toEqual([1_020, revivedAt + 40, null, restartedAt + 20]));
  } finally {
    vi.useRealTimers();
  }
});

test("captures claim fencing state when a request is queued", async () => {
  const landed: { at: number | null; throughOffset: number | undefined }[] = [];
  let throughOffset = 4;
  const claims = new BackgroundClaims<number>({
    claim: async (at, captured) => {
      landed.push({ at, throughOffset: captured });
    },
    capture: () => throughOffset,
    report: () => {},
    afterMs: 20,
    maxAfterMs: 80,
  });

  claims.at(null);
  throughOffset = 9;
  claims.at(10);

  await claims.flush();
  expect(landed).toEqual([
    { at: null, throughOffset: 4 },
    { at: 10, throughOffset: 9 },
  ]);
});

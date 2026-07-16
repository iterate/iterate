import { describe, expect, it } from "vitest";
import { StreamSearchIndexCoordinator } from "./stream-search-index-coordinator.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("StreamSearchIndexCoordinator", () => {
  it("serializes one stream and coalesces offsets that arrive during an active write", async () => {
    const firstWrite = deferred();
    const writes: number[][] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const coordinator = new StreamSearchIndexCoordinator(async ({ offsets }) => {
      writes.push(offsets);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (writes.length === 1) await firstWrite.promise;
      inFlight -= 1;
    });

    const first = coordinator.index({ projectId: "prj_1", path: "/", offsets: [1] });
    await Promise.resolve();
    const second = coordinator.index({ projectId: "prj_1", path: "/", offsets: [2, 3] });
    const third = coordinator.index({ projectId: "prj_1", path: "/", offsets: [3, 4] });

    expect(writes).toEqual([[1]]);
    firstWrite.resolve();
    await Promise.all([first, second, third]);

    expect(writes).toEqual([[1], [2, 3, 4]]);
    expect(maximumInFlight).toBe(1);
  });

  it("indexes different streams independently", async () => {
    const writes: string[] = [];
    const coordinator = new StreamSearchIndexCoordinator(async ({ path }) => {
      writes.push(path);
    });

    await Promise.all([
      coordinator.index({ projectId: "prj_1", path: "/a", offsets: [1] }),
      coordinator.index({ projectId: "prj_1", path: "/b", offsets: [1] }),
    ]);

    expect(writes.sort()).toEqual(["/a", "/b"]);
  });

  it("rejects only a failed wave and continues with work queued behind it", async () => {
    const firstWrite = deferred();
    let calls = 0;
    const coordinator = new StreamSearchIndexCoordinator(async () => {
      calls += 1;
      if (calls === 1) {
        await firstWrite.promise;
        throw new Error("write failed");
      }
    });

    const first = coordinator.index({ projectId: "prj_1", path: "/", offsets: [1] });
    await Promise.resolve();
    const second = coordinator.index({ projectId: "prj_1", path: "/", offsets: [2] });
    firstWrite.resolve();

    await expect(first).rejects.toThrow("write failed");
    await expect(second).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

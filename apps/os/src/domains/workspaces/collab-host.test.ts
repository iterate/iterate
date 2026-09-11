import { describe, expect, test, vi } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { MAX_DOC_BYTES } from "./collab-engine.ts";
import { CollabHost, type CollabSettledFs } from "./collab-host.ts";
import { fakeSessionStore } from "./collab-store.fixtures.ts";

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const state = { failWrites: false, writes: 0 };
  const fs: CollabSettledFs = {
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, content) => {
      state.writes++;
      if (state.failWrites) throw new Error("simulated overlay write failure");
      files.set(path, content);
    },
  };
  return { files, fs, state };
}

const PATH = "/tasks/demo.md";
const SEED = "settled text";

function pushOne(
  host: CollabHost,
  opened: { epoch: string; version: number },
  insert: string,
  docLength: number,
  seq = 0,
  clientId = "peer",
) {
  return host.push({
    baseVersion: opened.version,
    clientId,
    epoch: opened.epoch,
    ops: [
      { changes: ChangeSet.of({ from: 0, insert, to: 0 }, docLength).toJSON(), clientSeq: seq },
    ],
    path: PATH,
  });
}

describe("collab host", () => {
  test("acked edits survive eviction INTO a commit: reconcile flushes with no live memory", async () => {
    const { store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });

    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    expect((await pushOne(host, opened, "acked ", SEED.length)).status).toBe("accepted");
    // Eviction: the overlay never saw the edit (debounce hadn't fired).
    expect(files.get(PATH)).toBe(SEED);

    // A fresh incarnation (empty memory) runs the commit barrier.
    const rebooted = new CollabHost({ fs, store });
    await rebooted.reconcile();
    expect(files.get(PATH)).toBe(`acked ${SEED}`);
  });

  test("routing truth is durable: reads and writes route through the session after eviction", async () => {
    const { store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "live ", SEED.length);

    const rebooted = new CollabHost({ fs, store });
    // Agent read sees the durable head, not the stale overlay…
    expect(await rebooted.readFile(PATH)).toBe(`live ${SEED}`);
    // …and an agent write splices instead of stomping.
    expect(await rebooted.writeFile(PATH, `live ${SEED} plus-agent`)).toBe(true);
    expect(await rebooted.readFile(PATH)).toBe(`live ${SEED} plus-agent`);
    expect(files.get(PATH)).toBe(SEED); // overlay settles at the next barrier
    await rebooted.reconcile();
    expect(files.get(PATH)).toBe(`live ${SEED} plus-agent`);
  });

  test("endSessions: no resurrection, next open seeds fresh settled truth", async () => {
    const { sessions, store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "doomed ", SEED.length);

    host.endSessions([PATH]); // e.g. deleteFile — unflushed edits discarded
    expect(sessions.size).toBe(0);
    await host.reconcile(); // nothing dirty — the session is gone
    expect(files.get(PATH)).toBe(SEED);

    // The settled file changes (external commit); a later open seeds THAT,
    // not the old session's pinned content.
    files.set(PATH, "new upstream truth");
    const reopened = await host.open(PATH);
    expect(reopened).toMatchObject({ content: "new upstream truth", version: 0 });
    expect(reopened.epoch).not.toBe(opened.epoch);
  });

  test("edit uses canonical literal-replacement semantics ($& stays literal)", async () => {
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: "alpha MARKER omega" });
    const host = new CollabHost({ fs, store });
    await host.open(PATH);
    const result = await host.edit({ newString: "$& $' $1", oldString: "MARKER", path: PATH });
    expect(result).toEqual({ occurrenceCount: 1, path: PATH });
    expect(await host.readFile(PATH)).toBe("alpha $& $' $1 omega");
    await expect(host.edit({ newString: "x", oldString: "absent", path: PATH })).rejects.toThrow(
      "was not found",
    );
  });

  test("flush failure keeps the session durably dirty; the next barrier retries", async () => {
    const { store } = fakeSessionStore();
    const { files, fs, state } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "sticky ", SEED.length);

    state.failWrites = true;
    await expect(host.reconcile()).rejects.toThrow("overlay write failure");
    expect(
      store
        .sessions()
        .filter((s) => s.headVersion > s.overlayVersion)
        .map((s) => s.path),
    ).toEqual([PATH]);

    state.failWrites = false;
    await host.reconcile();
    expect(files.get(PATH)).toBe(`sticky ${SEED}`);
    expect(
      store
        .sessions()
        .filter((s) => s.headVersion > s.overlayVersion)
        .map((s) => s.path),
    ).toEqual([]);
  });

  test("open refuses files past the live-collaboration size cap", async () => {
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: "x".repeat(MAX_DOC_BYTES + 1) });
    const host = new CollabHost({ fs, store });
    await expect(host.open(PATH)).rejects.toThrow("file-too-large");
    expect(host.isLive(PATH)).toBe(false);
  });

  test("wait parks, wakes on push, and cleans its waiter up on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeSessionStore();
      const { fs } = fakeFs({ [PATH]: SEED });
      const host = new CollabHost({ fs, store });
      const opened = await host.open(PATH);

      // Timeout path: the waiter must remove itself.
      const timedOut = host.wait(PATH, opened.epoch, opened.version);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await timedOut).toEqual({ ops: [], status: "ops" });

      // Wake path: a push resolves the parked wait with its op.
      const parked = host.wait(PATH, opened.epoch, opened.version);
      await pushOne(host, opened, "wake ", SEED.length);
      const delivered = await parked;
      expect(delivered.status).toBe("ops");
      if (delivered.status === "ops") expect(delivered.ops).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("first touch after eviction must NOT idle-end other live sessions", async () => {
    vi.useFakeTimers({ now: 10 * 60_000 }); // well past IDLE_END_MS since epoch 0
    try {
      const OTHER = "/other/task.md";
      const { sessions, store } = fakeSessionStore();
      const { fs } = fakeFs({ [PATH]: SEED, [OTHER]: "other seed" });
      const host = new CollabHost({ fs, store });
      await host.open(PATH);
      await host.open(OTHER);

      // Eviction: fresh incarnation with NO activity memory. The first open
      // sweeps — unknown activity must read as "just seen", never "ancient".
      const rebooted = new CollabHost({ fs, store });
      await rebooted.open(PATH);
      await Promise.resolve(); // let the fire-and-forget sweep run
      expect(sessions.has(OTHER)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a parked wait resolves 'ended' when the session is destroyed", async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeSessionStore();
      const { fs } = fakeFs({ [PATH]: SEED });
      const host = new CollabHost({ fs, store });
      const opened = await host.open(PATH);
      const parked = host.wait(PATH, opened.epoch, opened.version);
      await vi.advanceTimersByTimeAsync(10);
      host.endSessions([PATH]); // deleteFile / reset / binary replace
      expect(await parked).toEqual({ status: "ended" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("an IN-FLIGHT flush aborted by destruction cannot resurrect the file", async () => {
    const { store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let reads = 0;
    const slowFs: CollabSettledFs = {
      readFile: async (path) => {
        // Only the flush's pre-write read is slowed (open performs TWO reads:
        // the seed and the post-birth reconcile that closes the seed window).
        if (++reads > 2) await gate;
        return fs.readFile(path);
      },
      writeFile: fs.writeFile,
    };
    const host = new CollabHost({ fs: slowFs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "doomed ", SEED.length);

    const flushing = host.reconcile(); // enters #flush, parks on the slow read
    await Promise.resolve();
    host.endSessions([PATH]); // deleteFile lands mid-flight
    releaseRead();
    await flushing;
    expect(files.get(PATH)).toBe(SEED); // never written — no resurrection
  });

  test("a delete racing a slow-seeding open wins: no resurrection", async () => {
    const { sessions, store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: SEED });
    let releaseSeed: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseSeed = resolve));
    const slowFs: CollabSettledFs = {
      readFile: async (path) => {
        await gate;
        return fs.readFile(path);
      },
      writeFile: fs.writeFile,
    };
    const host = new CollabHost({ fs: slowFs, store });
    const opening = host.open(PATH);
    host.endSessions([PATH]); // the delete lands mid-seed
    releaseSeed();
    await expect(opening).rejects.toThrow("was deleted while the session was opening");
    expect(sessions.size).toBe(0);
    expect(store.hasSession(PATH)).toBe(false);
  });

  test("idle sweep ends clean sessions so stale pins cannot outlive interest", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { sessions, store } = fakeSessionStore();
      const { files, fs } = fakeFs({ [PATH]: SEED });
      const host = new CollabHost({ fs, store });
      const opened = await host.open(PATH); // open records activity
      await pushOne(host, opened, "final ", SEED.length);

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await host.sweepIdle(Date.now());
      expect(files.get(PATH)).toBe(`final ${SEED}`); // settled on the way out
      expect(sessions.size).toBe(0); // durably ended
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("collab host regressions", () => {
  test("versions() reports durable session heads after eviction", async () => {
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "hi ", SEED.length);
    // A fresh incarnation over the same durable store has no in-memory
    // engines yet — the board's change cursor must still see the session.
    const rebooted = new CollabHost({ fs, store });
    const versions = rebooted.versions();
    expect(versions[PATH]).toBeGreaterThanOrEqual(1);
  });
});

describe("flush dirtiness", () => {
  test("an unedited session never writes its seed over a moved mount HEAD", async () => {
    const { store } = fakeSessionStore();
    const { files, fs, state } = fakeFs({ [PATH]: "seed text" });
    const host = new CollabHost({ fs, store });
    await host.open(PATH);
    // Upstream moves (a commit on another workspace, a mount re-point): the
    // settled truth changes while the session sits unedited.
    files.set(PATH, "moved HEAD text");
    await host.reconcile();
    expect(files.get(PATH)).toBe("moved HEAD text");
    expect(state.writes).toBe(0);
  });

  test("a dirty session still settles its head", async () => {
    const { store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "hi ", SEED.length);
    await host.reconcile();
    expect(files.get(PATH)).toBe(`hi ${SEED}`);
  });
});

describe("open seed race", () => {
  test("a settled write landing during the seed read is reflected in the born session", async () => {
    const { store } = fakeSessionStore();
    const files = new Map([[PATH, "first"]]);
    let reads = 0;
    const gate: { release?: () => void } = {};
    const fs: CollabSettledFs = {
      readFile: async (path) => {
        reads++;
        // Snapshot BEFORE parking: the settled layer answered with the old
        // text, and the write lands while the seed is still in flight.
        const snapshot = files.get(path) ?? null;
        if (reads === 1) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return snapshot;
        }
        return files.get(path) ?? null;
      },
      writeFile: async (path, content) => void files.set(path, content),
    };
    const host = new CollabHost({ fs, store });
    const opening = host.open(PATH);
    // Wait until the seed read is parked, then land the write and release.
    while (gate.release === undefined) await new Promise((r) => setTimeout(r, 1));
    files.set(PATH, "second");
    gate.release();
    await opening;
    expect(await host.readFile(PATH)).toBe("second");
  });
});

describe("open unwind windows", () => {
  test("a delete during the post-birth reconcile read unwinds the open", async () => {
    const { store } = fakeSessionStore();
    const files = new Map([[PATH, "seed"]]);
    let reads = 0;
    const gate: { release?: () => void } = {};
    const fs: CollabSettledFs = {
      readFile: async (path) => {
        reads++;
        const snapshot = files.get(path) ?? null;
        if (reads === 2) {
          // Park the RECONCILE read (the seed read is first) while the
          // destructive op lands.
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return snapshot;
      },
      writeFile: async (path, content) => void files.set(path, content),
    };
    const host = new CollabHost({ fs, store });
    const opening = host.open(PATH);
    while (gate.release === undefined) await new Promise((r) => setTimeout(r, 1));
    host.endSessions([PATH]);
    gate.release();
    await expect(opening).rejects.toThrow(/deleted while the session was opening/);
    expect(host.isLive(PATH)).toBe(false);
  });
});

describe("presence", () => {
  test("presence: announces wake parked waits coalesced, deliver on the pull, and die with the session", async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeSessionStore();
      const { fs } = fakeFs({ [PATH]: SEED });
      const host = new CollabHost({ fs, store });
      const opened = await host.open(PATH);

      // A parked wait (no ops) that tracks presence from generation 0.
      const parked = host.wait(PATH, opened.epoch, opened.version, "watcher", 0);
      await vi.advanceTimersByTimeAsync(1);

      host.present(PATH, "u-ada-abc123", { anchor: 3, head: 7 });
      host.present(PATH, "u-ada-abc123", { anchor: 4, head: 8 }); // coalesces
      await vi.advanceTimersByTimeAsync(150);
      const pull = await parked;
      if (pull.status !== "ops") throw new Error(`expected ops, got ${pull.status}`);
      expect(pull.presence).toBeDefined();
      expect(pull.presence!.clients).toEqual([
        { anchor: 4, at: expect.any(Number), clientId: "u-ada-abc123", head: 8 },
      ]);

      // A wait already past the generation parks instead of spinning.
      const caughtUp = host.wait(
        PATH,
        opened.epoch,
        opened.version,
        "watcher",
        pull.presence!.generation,
      );
      await vi.advanceTimersByTimeAsync(1);
      host.present(PATH, "u-ada-abc123", null); // leaving clears the caret
      await vi.advanceTimersByTimeAsync(150);
      const afterLeave = await caughtUp;
      if (afterLeave.status !== "ops") throw new Error(`expected ops, got ${afterLeave.status}`);
      expect(afterLeave.presence!.clients).toEqual([]);

      // The board's summary sees the caret again once re-announced.
      host.present(PATH, "u-ada-abc123", { anchor: 1, head: 1 });
      expect(host.presenceSummary()).toEqual({ [PATH]: ["u-ada-abc123"] });

      // Destructive end wipes presence state with the session.
      host.endSessions([PATH]);
      expect(() => host.present(PATH, "u-ada-abc123", { anchor: 0, head: 0 })).not.toThrow();
      expect(host.presenceSummary()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

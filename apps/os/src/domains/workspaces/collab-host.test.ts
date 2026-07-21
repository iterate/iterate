import { describe, expect, test, vi } from "vitest";
import { MAX_DOC_BYTES } from "./collab-engine.ts";
import { CollabHost, type CollabSettledFs } from "./collab-host.ts";
import { fakeSessionStore } from "./collab-store.fixtures.ts";
import { ChangeSet } from "@codemirror/state";

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
    expect(store.dirtySessions()).toEqual([PATH]);

    state.failWrites = false;
    await host.reconcile();
    expect(files.get(PATH)).toBe(`sticky ${SEED}`);
    expect(store.dirtySessions()).toEqual([]);
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

  test("redline cycle: attributed changes since birth, reset by commit, resumed after", async () => {
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);

    // Two humans and an agent touch the file.
    await pushOne(host, opened, "one ", SEED.length, 0, "alice");
    await host.push({
      baseVersion: 1,
      clientId: "bob",
      epoch: opened.epoch,
      ops: [
        {
          changes: ChangeSet.of(
            { from: 4, insert: "", to: 4 + SEED.length },
            SEED.length + 4,
          ).toJSON(),
          clientSeq: 0,
        },
      ],
      path: PATH,
    });
    await host.writeFile(PATH, "one [agent]");

    const before = await host.changes(PATH);
    expect(before.baseVersion).toBe(0);
    expect(before.headVersion).toBe(3);
    const authors = new Set(before.segments.map((segment) => segment.clientId));
    expect(authors).toEqual(new Set(["alice", "bob", "external"]));
    const deletion = before.segments.find((segment) => segment.kind === "deleted");
    expect(deletion).toMatchObject({ text: SEED }); // bob deleted the base text

    // Commit: reconcile → (core commit) → markCommitted resets the baseline.
    const settled = await host.reconcile();
    host.markCommitted(settled);
    const after = await host.changes(PATH);
    expect(after).toMatchObject({ baseVersion: 3, headVersion: 3, segments: [] });

    // Post-commit edits redline against the NEW base only. (clientSeq
    // continues from alice's confirmed count — seq 0 would be deduped.)
    await pushOne(host, { epoch: opened.epoch, version: 3 }, "post ", 11, 1, "alice");
    const next = await host.changes(PATH);
    expect(next.segments).toEqual([{ clientId: "alice", from: 0, kind: "inserted", to: 5 }]);
  });

  test("redline survives compaction: ops retained back to the baseline", async () => {
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: SEED });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);

    // Drive far past SNAPSHOT_EVERY without committing; the first op deletes
    // base text whose recovery requires the full op tail back to version 0.
    await host.push({
      baseVersion: 0,
      clientId: "deleter",
      epoch: opened.epoch,
      ops: [
        {
          changes: ChangeSet.of({ from: 0, insert: "", to: 8 }, SEED.length).toJSON(),
          clientSeq: 0,
        },
      ],
      path: PATH,
    });
    for (let index = 0; index < 300; index++) {
      const head = (await host.readFile(PATH))!;
      const result = await host.push({
        baseVersion: index + 1,
        clientId: "typist",
        epoch: opened.epoch,
        ops: [
          {
            changes: ChangeSet.of({ from: 0, insert: "x", to: 0 }, head.length).toJSON(),
            clientSeq: index,
          },
        ],
        path: PATH,
      });
      expect(result.status).toBe("accepted");
    }

    const redline = await host.changes(PATH);
    expect(redline.headVersion).toBe(301);
    const deletion = redline.segments.find((segment) => segment.kind === "deleted");
    expect(deletion).toMatchObject({ clientId: "deleter", text: "settled " });
  });

  test("mount-scoped commit stamping: unstamped sessions keep their redline", async () => {
    const OTHER = "/other/task.md";
    const { store } = fakeSessionStore();
    const { fs } = fakeFs({ [PATH]: SEED, [OTHER]: "other seed" });
    const host = new CollabHost({ fs, store });
    const opened = await host.open(PATH);
    const openedOther = await host.open(OTHER);
    await pushOne(host, opened, "committed ", SEED.length);
    await host.push({
      baseVersion: openedOther.version,
      clientId: "peer",
      epoch: openedOther.epoch,
      ops: [
        { changes: ChangeSet.of({ from: 0, insert: "kept ", to: 0 }, 10).toJSON(), clientSeq: 0 },
      ],
      path: OTHER,
    });

    // The DO filters the barrier's settled files to the committed mount; the
    // contract markCommitted must honor: only stamped paths advance.
    const settled = await host.reconcile();
    host.markCommitted(settled.filter((file) => file.path === PATH));

    expect((await host.changes(PATH)).segments).toEqual([]);
    const other = await host.changes(OTHER);
    expect(other.segments).toEqual([{ clientId: "peer", from: 0, kind: "inserted", to: 5 }]);
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
        // Only the flush's pre-write read is slowed (the seed read is first).
        if (++reads > 1) await gate;
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

  test("commit stamping matches EXACTLY what was flushed, even under racing pushes", async () => {
    const { store } = fakeSessionStore();
    const { files, fs } = fakeFs({ [PATH]: SEED });
    let slowWrites = false;
    let releaseWrite: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseWrite = resolve));
    const slowFs: CollabSettledFs = {
      readFile: fs.readFile,
      writeFile: async (path, content) => {
        if (slowWrites) await gate;
        return fs.writeFile(path, content);
      },
    };
    const host = new CollabHost({ fs: slowFs, store });
    const opened = await host.open(PATH);
    await pushOne(host, opened, "committed ", SEED.length);

    slowWrites = true;
    const barrier = host.reconcile(); // captures the head, parks on the write
    await Promise.resolve();
    // A keystroke races the barrier: accepted AFTER the head was captured.
    await pushOne(host, { epoch: opened.epoch, version: 1 }, "late ", SEED.length + 10, 1);
    releaseWrite();
    const settled = await barrier;
    host.markCommitted(settled);

    // The stamped baseline is what the overlay (and the commit) contains…
    expect(settled).toEqual([{ content: `committed ${SEED}`, path: PATH, version: 1 }]);
    expect(files.get(PATH)).toBe(`committed ${SEED}`);
    // …and the raced push SURVIVES in the redline instead of vanishing.
    const redline = await host.changes(PATH);
    expect(redline.segments).toEqual([{ clientId: "peer", from: 0, kind: "inserted", to: 5 }]);
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

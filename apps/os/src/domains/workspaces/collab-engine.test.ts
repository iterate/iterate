import { describe, expect, test } from "vitest";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import {
  CollabEngine,
  MAX_PUSH_BYTES,
  minimalSplice,
  type CollabBroadcast,
  type CollabSnapshot,
  type CollabStore,
  type PersistedCollabOp,
} from "./collab-engine.ts";

/** In-memory store where `append` resolving IS the durability line; a
 * "crash" discards every engine (memory) but never what append accepted.
 * putSnapshot mirrors the SQLite impl's compaction: prune covered ops. */
export function fakeStore() {
  const ops = new Map<string, PersistedCollabOp[]>();
  const snapshots = new Map<string, CollabSnapshot>();
  const state = { appendCalls: 0, failNextAppend: false };
  const store: CollabStore = {
    append: async (path, _epoch, batch) => {
      state.appendCalls++;
      if (state.failNextAppend) {
        state.failNextAppend = false;
        throw new Error("simulated crash before durability");
      }
      ops.set(path, [...(ops.get(path) ?? []), ...structuredClone(batch)]);
    },
    getSnapshot: async (path) => structuredClone(snapshots.get(path) ?? null),
    putSnapshot: async (path, snapshot) => {
      snapshots.set(path, structuredClone(snapshot));
      ops.set(
        path,
        (ops.get(path) ?? []).filter((op) => op.version >= snapshot.version),
      );
    },
    readOps: async (path, _epoch, afterVersion) =>
      structuredClone((ops.get(path) ?? []).filter((op) => op.version > afterVersion)),
  };
  return { ops, snapshots, state, store };
}

const PATH = "/tasks/demo.md";
const EPOCH = "epoch-1";
const SEED = "hello collaborative world";

function makeEngine(store: CollabStore, broadcasts: CollabBroadcast[] = []) {
  return new CollabEngine({ broadcast: (event) => broadcasts.push(event), store });
}

/** A real @codemirror/collab peer driven headlessly. */
class Peer {
  state: EditorState;
  /** Own updates seen back in broadcasts — the stable clientSeq base. */
  confirmed = 0;

  constructor(
    readonly id: string,
    doc: string,
    version: number,
  ) {
    this.state = EditorState.create({
      doc,
      extensions: [collab({ clientID: id, startVersion: version })],
    });
  }

  edit(from: number, to: number, insert: string) {
    this.state = this.state.update({ changes: { from, insert, to } }).state;
  }

  /** Batch for the server; clientSeqs are stable across retries. */
  sendable() {
    const updates = sendableUpdates(this.state);
    return {
      baseVersion: getSyncedVersion(this.state),
      clientId: this.id,
      epoch: EPOCH,
      ops: updates.map((update, index) => ({
        changes: update.changes.toJSON(),
        clientSeq: this.confirmed + index,
      })),
      path: PATH,
    };
  }

  receive(ops: { changes: unknown; clientId: string }[]) {
    this.confirmed += ops.filter((op) => op.clientId === this.id).length;
    const updates: Update[] = ops.map((op) => ({
      changes: ChangeSet.fromJSON(op.changes),
      clientID: op.clientId,
    }));
    this.state = receiveUpdates(this.state, updates).state;
  }

  get doc() {
    return this.state.doc.toString();
  }
  get version() {
    return getSyncedVersion(this.state);
  }
}

/** Deliver everything until the whole system is quiescent and converged. */
async function syncAll(engine: CollabEngine, peers: Peer[]) {
  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (const peer of peers) {
      const gap = await engine.pull(PATH, EPOCH, peer.version);
      if (gap.status === "ops" && gap.ops.length > 0) {
        peer.receive(gap.ops);
        moved = true;
      }
      const batch = peer.sendable();
      if (batch.ops.length > 0) {
        const result = await engine.push(batch);
        expect(result.status).toBe("accepted");
        moved = true;
      }
    }
    if (!moved) return;
  }
  throw new Error("did not quiesce");
}

const seeded = () => async () => ({ content: SEED, epoch: EPOCH });

describe("collab engine", () => {
  test("two peers converge on interleaved concurrent edits", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    const b = new Peer("b", opened.content, opened.version);
    a.edit(0, 0, "A> ");
    b.edit(SEED.length, SEED.length, " <B");

    // a pushes at head; b's push is stale (baseVersion 0 vs head 1) and gets
    // rebased server-side rather than rejected.
    expect((await engine.push(a.sendable())).status).toBe("accepted");
    expect((await engine.push(b.sendable())).status).toBe("accepted");
    await syncAll(engine, [a, b]);

    expect(a.doc).toBe("A> hello collaborative world <B");
    expect(b.doc).toBe(a.doc);
    expect(engine.head(PATH)?.content).toBe(a.doc);
  });

  test("duplicate push after a lost ack applies exactly once", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    a.edit(0, 0, "once ");
    const batch = a.sendable();
    expect((await engine.push(batch)).status).toBe("accepted");
    const retry = await engine.push(structuredClone(batch));
    expect(retry).toEqual({ status: "accepted", version: 1 });
    expect(engine.head(PATH)?.content).toBe(`once ${SEED}`);
  });

  test("mixed retry batch (accepted prefix + new ops) lands the tail once", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    const b = new Peer("b", opened.content, opened.version);
    a.edit(0, 0, "one ");
    expect((await engine.push(a.sendable())).status).toBe("accepted"); // seq 0 accepted, ack "lost"
    b.edit(SEED.length, SEED.length, "!");
    expect((await engine.push(b.sendable())).status).toBe("accepted");
    // a never confirmed, edits more, resends BOTH ops at the old base.
    a.edit(4, 4, "two ");
    const retry = a.sendable();
    expect(retry.ops).toHaveLength(2);
    expect(retry.baseVersion).toBe(0);
    expect((await engine.push(retry)).status).toBe("accepted");
    await syncAll(engine, [a, b]);
    expect(a.doc).toBe(`one two ${SEED}!`);
    expect(b.doc).toBe(a.doc);
  });

  test("epoch mismatch is rejected with the current epoch", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());
    const result = await engine.push({
      baseVersion: opened.version,
      clientId: "stale",
      epoch: "some-old-epoch",
      ops: [{ changes: ChangeSet.of([], SEED.length).toJSON(), clientSeq: 0 }],
      path: PATH,
    });
    expect(result).toEqual({ epoch: EPOCH, status: "epoch-mismatch" });
  });

  test("concurrent first opens join one boot: one epoch, no version collision", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    let seeds = 0;
    const slowSeed = async () => {
      seeds++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { content: SEED, epoch: `epoch-${seeds}` };
    };
    const [first, second] = await Promise.all([
      engine.open(PATH, slowSeed),
      engine.open(PATH, slowSeed),
    ]);
    expect(seeds).toBe(1);
    expect(first.epoch).toBe(second.epoch);
  });

  test("crash after ack loses nothing: reboot replays snapshot + ops", async () => {
    const { state, store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    a.edit(0, 0, "durable ");
    expect((await engine.push(a.sendable())).status).toBe("accepted");
    const appendsBefore = state.appendCalls;

    // Crash: new engine over the same store. Seed must NOT run again.
    const rebooted = makeEngine(store);
    const reopened = await rebooted.open(PATH, async () => {
      throw new Error("seed must not be consulted after a durable session exists");
    });
    expect(reopened).toEqual({ content: `durable ${SEED}`, epoch: EPOCH, version: 1 });
    expect(state.appendCalls).toBe(appendsBefore);

    // The peer reconnects with its pre-push synced version: it receives its
    // own op back, which is exactly how the ack-was-lost case confirms.
    const gap = await rebooted.pull(PATH, EPOCH, a.version);
    expect(gap.status).toBe("ops");
    if (gap.status === "ops") {
      expect(gap.ops).toHaveLength(1);
      a.receive(gap.ops);
    }
    expect(a.doc).toBe(`durable ${SEED}`);
    expect(a.version).toBe(1);
  });

  test("crash before durability: push fails, retry lands exactly once", async () => {
    const broadcasts: CollabBroadcast[] = [];
    const { state, store } = fakeStore();
    const engine = makeEngine(store, broadcasts);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    a.edit(0, 0, "retry ");
    const batch = a.sendable();
    state.failNextAppend = true;
    await expect(engine.push(batch)).rejects.toThrow("simulated crash");
    expect(engine.head(PATH)?.content).toBe(SEED);
    expect(broadcasts.filter((event) => event.path === PATH)).toHaveLength(0);

    expect(await engine.push(structuredClone(batch))).toEqual({
      status: "accepted",
      version: 1,
    });
    expect(engine.head(PATH)?.content).toBe(`retry ${SEED}`);
  });

  test("reboot from a MID-SESSION snapshot plus op tail (past SNAPSHOT_EVERY)", async () => {
    const { ops, snapshots, store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());
    const busy = new Peer("busy", opened.content, opened.version);
    for (let index = 0; index < 300; index++) {
      busy.edit(0, 0, "x");
      expect((await engine.push(busy.sendable())).status).toBe("accepted");
      const gap = await engine.pull(PATH, EPOCH, busy.version);
      if (gap.status === "ops") busy.receive(gap.ops);
    }
    // Compaction ran: snapshot advanced past 0 and covered ops were pruned.
    expect(snapshots.get(PATH)!.version).toBeGreaterThanOrEqual(256);
    expect(ops.get(PATH)!.every((op) => op.version >= snapshots.get(PATH)!.version)).toBe(true);

    const rebooted = makeEngine(store);
    const reopened = await rebooted.open(PATH, async () => {
      throw new Error("seed after crash");
    });
    expect(reopened.version).toBe(300);
    expect(reopened.content).toBe(engine.head(PATH)!.content);
  });

  test("stale beyond the history window gets history-miss; pull serves a snapshot", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());
    const busy = new Peer("busy", opened.content, opened.version);
    for (let index = 0; index < 1010; index++) {
      busy.edit(0, 0, "x");
      expect((await engine.push(busy.sendable())).status).toBe("accepted");
      const gap = await engine.pull(PATH, EPOCH, busy.version);
      if (gap.status === "ops") busy.receive(gap.ops);
    }
    const sleeper = new Peer("sleeper", opened.content, 0);
    sleeper.edit(0, 0, "late ");
    expect((await engine.push(sleeper.sendable())).status).toBe("history-miss");
    expect((await engine.pull(PATH, EPOCH, 0)).status).toBe("snapshot");
  });

  test("oversized push is refused with a typed status and the session survives", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const monster = "x".repeat(MAX_PUSH_BYTES + 1024);
    const result = await engine.push({
      baseVersion: opened.version,
      clientId: "paster",
      epoch: opened.epoch,
      ops: [
        {
          changes: ChangeSet.of({ from: 0, insert: monster, to: 0 }, SEED.length).toJSON(),
          clientSeq: 0,
        },
      ],
      path: PATH,
    });
    expect(result).toEqual({ maxBytes: MAX_PUSH_BYTES, status: "too-large" });
    expect(engine.head(PATH)).toEqual({ content: SEED, epoch: EPOCH, version: 0 });

    // A normal push afterwards is unaffected.
    const a = new Peer("a", SEED, 0);
    a.edit(0, 0, "ok ");
    expect((await engine.push(a.sendable())).status).toBe("accepted");
  });

  test("applyExternal splices at head while a peer holds unconfirmed edits", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());

    const a = new Peer("a", opened.content, opened.version);
    a.edit(0, 0, "human "); // unconfirmed, not yet pushed
    const external = await engine.applyExternal(PATH, (doc) =>
      minimalSplice(doc, `${doc.toString()} [agent]`),
    );
    expect(external.version).toBe(1);
    // The peer pushes its stale batch; the server rebases it over the agent op.
    expect((await engine.push(a.sendable())).status).toBe("accepted");
    await syncAll(engine, [a]);
    expect(a.doc).toBe(`human ${SEED} [agent]`);
    expect(engine.head(PATH)!.content).toBe(a.doc);
  });

  test("dedupe identities are RETAINED for the session — idempotency is a guarantee", async () => {
    const { snapshots, store } = fakeStore();
    const engine = makeEngine(store);
    const opened = await engine.open(PATH, seeded());
    for (let index = 0; index < 300; index++) {
      const result = await engine.push({
        baseVersion: index,
        clientId: `ephemeral-${index}`,
        epoch: opened.epoch,
        ops: [
          {
            changes: ChangeSet.of({ from: 0, insert: ".", to: 0 }, SEED.length + index).toJSON(),
            clientSeq: 0,
          },
        ],
        path: PATH,
      });
      expect(result.status).toBe("accepted");
    }
    // Evicting any identity would let that client's retry re-apply; growth is
    // bounded by the SESSION lifecycle (destruction/idle end), never an LRU.
    // The guarantee itself: the very FIRST client's lost-ack retry, 299
    // authors later, is still recognized and dropped.
    void snapshots;
    const retry = await engine.push({
      baseVersion: 300,
      clientId: "ephemeral-0",
      epoch: opened.epoch,
      ops: [
        {
          changes: ChangeSet.of({ from: 0, insert: ".", to: 0 }, SEED.length + 300).toJSON(),
          clientSeq: 0,
        },
      ],
      path: PATH,
    });
    expect(retry).toEqual({ status: "accepted", version: 300 }); // deduped, no new op
  });

  test.each([42, 7, 1337, 2024, 555])(
    "fuzz seed %i: random edits, dropped deliveries, external writes, crashes",
    async (seed) => {
      let rng = seed;
      const random = () => {
        // mulberry32 — deterministic, seedable.
        rng |= 0;
        rng = (rng + 0x6d2b79f5) | 0;
        let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const { store } = fakeStore();
      let engine = makeEngine(store);
      const opened = await engine.open(PATH, seeded());
      const peers = ["p1", "p2", "p3"].map((id) => new Peer(id, opened.content, opened.version));

      for (let step = 0; step < 400; step++) {
        const peer = peers[Math.floor(random() * peers.length)]!;
        const action = random();
        if (action < 0.4) {
          const doc = peer.state.doc;
          const at = Math.floor(random() * (doc.length + 1));
          if (random() < 0.3 && doc.length > 0) {
            peer.edit(Math.max(0, at - 1), at, "");
          } else {
            peer.edit(at, at, String.fromCharCode(97 + Math.floor(random() * 26)));
          }
        } else if (action < 0.7) {
          const batch = peer.sendable();
          if (batch.ops.length > 0) {
            const result = await engine.push(batch).catch(() => null);
            if (result) expect(result.status).toBe("accepted");
          }
        } else if (action < 0.9) {
          const gap = await engine.pull(PATH, EPOCH, peer.version);
          if (gap.status === "ops" && random() < 0.8) peer.receive(gap.ops);
        } else if (action < 0.95) {
          // An agent writes through the external door mid-melee.
          await engine.applyExternal(PATH, (doc) =>
            minimalSplice(doc, `${doc.toString().slice(0, Math.floor(random() * doc.length))}Z`),
          );
        } else {
          // Crash the authority mid-run; durable state must carry the session.
          engine = makeEngine(store);
          await engine.open(PATH, async () => {
            throw new Error("seed after crash");
          });
        }
      }

      await syncAll(engine, peers);
      const settled = engine.head(PATH)!.content;
      for (const peer of peers) expect(peer.doc).toBe(settled);
      // The fold of the durable log equals the live head — replay proves it.
      const rebooted = makeEngine(store);
      const reopened = await rebooted.open(PATH, async () => {
        throw new Error("seed after crash");
      });
      expect(reopened.content).toBe(settled);
    },
  );

  test("head text round-trips through Text without newline damage", async () => {
    const { store } = fakeStore();
    const engine = makeEngine(store);
    await engine.open(PATH, async () => ({ content: `${SEED}\n\nsettled\n`, epoch: EPOCH }));
    const head = engine.head(PATH)!;
    expect(Text.of(head.content.split("\n")).toString()).toBe(head.content);
  });
});

describe("doc size gate", () => {
  test("caps by UTF-8 bytes: multibyte docs reject before the char cap", async () => {
    const store = fakeStore().store;
    const engine = new CollabEngine({ store });
    await engine.open(PATH, async () => ({ content: "", epoch: "e-bytes" }));
    // '€' is 1 UTF-16 unit but 3 UTF-8 bytes: ~366k of them stay far under
    // the 1,048,576-char gate while crossing the byte cap.
    const chunk = "€".repeat(61_000); // 183KB per splice, under MAX_PUSH_BYTES
    let rejected = false;
    for (let index = 0; index < 6; index++) {
      try {
        await engine.applyExternal(PATH, (doc) =>
          ChangeSet.of({ from: doc.length, insert: chunk, to: doc.length }, doc.length),
        );
      } catch (error) {
        rejected = true;
        expect(String(error)).toContain("too-large");
        break;
      }
    }
    expect(rejected).toBe(true);
  });
});

describe("discard during boot", () => {
  test("a discard mid-boot unwinds the open instead of reviving an orphan engine", async () => {
    const store = fakeStore().store;
    const engine = new CollabEngine({ store });
    const gate: { release?: () => void } = {};
    const opening = engine.open(PATH, async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { content: "doomed seed", epoch: "e-orphan" };
    });
    while (!gate.release) await new Promise((r) => setTimeout(r, 1));
    engine.discard(PATH); // destructive op lands while the seed is in flight
    gate.release();
    await expect(opening).rejects.toThrow(/ended while opening/);
    // A later open must SEED FRESH, never resurrect the discarded engine.
    const reopened = await engine.open(PATH, async () => ({
      content: "fresh truth",
      epoch: "e-fresh",
    }));
    expect(reopened.content).toBe("fresh truth");
    expect(reopened.epoch).toBe("e-fresh");
  });
});

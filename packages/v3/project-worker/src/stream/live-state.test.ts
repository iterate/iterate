// live-state.test.ts — the holder's revision-chain contract, pinned at the unit level. The load-
// bearing property: EVERY base move advances the rev, so any client that missed an emission sees a
// chain gap (mismatching `from`) and re-seeds — the swallowed-diff branch must never let a later
// patch land on a base the client never received, and never wedge emission.

import { expect, test } from "vitest";
import { applyPatch, type PatchOp } from "../lib/patch.ts";
import { LiveState } from "./live-state.ts";

type Frame = { key: string; from: number; to: number; patch: PatchOp[] };

const collectingSink = () => {
  const frames: Frame[] = [];
  return {
    frames,
    append(event: { type: string; ephemeral?: true; payload?: Record<string, unknown> }) {
      frames.push(event.payload as Frame);
      return Promise.resolve();
    },
  };
};

test("set() chains rev exactly and emits the diff a client can apply", () => {
  const sink = collectingSink();
  const live = new LiveState(sink, "k", { n: 0 });
  const epoch = live.snapshot().rev;
  live.set({ n: 1 });
  live.set({ n: 2 });
  expect(sink.frames.map((f) => [f.from, f.to])).toEqual([
    [epoch, epoch + 1],
    [epoch + 1, epoch + 2],
  ]);
  // a client seeded at the epoch replays the chain to the held value
  let doc: unknown = { n: 0 };
  for (const f of sink.frames) doc = applyPatch(doc, f.patch);
  expect(doc).toEqual({ n: 2 });
  expect(live.snapshot()).toEqual({ rev: epoch + 2, state: { n: 2 } });
});

test("an unchanged set emits nothing and leaves the rev alone", () => {
  const sink = collectingSink();
  const live = new LiveState(sink, "k", { n: 1 });
  const epoch = live.snapshot().rev;
  live.set({ n: 1 });
  expect(sink.frames).toEqual([]);
  expect(live.snapshot().rev).toBe(epoch);
});

test("an unserializable value can't corrupt or wedge the chain — a gap, then diffing resumes off the last serialized base", () => {
  // The corruption this pins: set(S1) where diff throws (BigInt) adopts S1 with NO emit. Two hazards:
  //   (1) if the rev did not advance, the next emit's `from` would match a stale client's held rev
  //       and it would apply a patch computed against a base it never received (silent corruption);
  //   (2) if the poisoned value became the diff BASE, every later diff against it would throw too
  //       and emission would never resume (a silently wedged chain).
  const sink = collectingSink();
  const live = new LiveState<Record<string, unknown>>(sink, "k", { n: 0 });
  const epoch = live.snapshot().rev;
  live.set({ n: 1 }); // client syncs through this frame → holds rev epoch+1
  expect(sink.frames).toHaveLength(1);

  live.set({ n: 1, big: 10n }); // the diff throws → adopted, no emit, rev advances, base stays {n:1}
  expect(sink.frames).toHaveLength(1);
  expect(live.snapshot()).toEqual({ rev: epoch + 2, state: { n: 1, big: 10n } });

  // emission RESUMES as a diff from the last SERIALIZED base ({n:1}), never from the poisoned value
  live.set({ n: 2 });
  expect(sink.frames).toHaveLength(2);
  expect(sink.frames[1]).toEqual({
    key: "k",
    from: epoch + 2, // NOT the client's epoch+1 — it re-seeds through the door instead of applying
    to: epoch + 3,
    patch: [{ op: "replace", path: "/n", value: 2 }],
  });

  // and normal diffing resumes off the healed base
  live.set({ n: 3 });
  expect(sink.frames).toHaveLength(3);
  expect(sink.frames[2].from).toBe(epoch + 3);
  expect(sink.frames[2].patch).toEqual([{ op: "replace", path: "/n", value: 3 }]);
});

test("a synchronously-throwing sink is contained (lossy notification, value still adopted)", () => {
  const live = new LiveState(
    {
      append() {
        throw new Error("sink down");
      },
    },
    "k",
    { n: 0 },
  );
  const epoch = live.snapshot().rev;
  expect(() => live.set({ n: 1 })).not.toThrow();
  // the value and the rev both advanced — the lost emission is a chain gap, not lost state
  expect(live.snapshot()).toEqual({ rev: epoch + 1, state: { n: 1 } });
});

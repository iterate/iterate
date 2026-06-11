// Unit tests for the itx core (itx.ts): one Itx over an in-memory journal
// with a fake dial and a fake parent — no workerd, no SQLite, no streams
// service. This is the workshop's test bed: if a behavior matters to the
// design, it should be provable here — including the journal discipline
// itself (events are the only writes; a fresh instance over the same journal
// folds to the same state).

import { describe, expect, test, vi } from "vitest";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import {
  ITX_EVENT_TYPES,
  Itx,
  reduceItxJournalEvent,
  type CapabilityAddress,
  type CapabilityDial,
  type ItxOrigin,
  type ItxStub,
} from "./itx.ts";

const AI_ADDRESS: CapabilityAddress = {
  type: "rpc",
  worker: { binding: "AI", type: "binding" },
};

const LOOPBACK_ADDRESS: CapabilityAddress = {
  entrypoint: "StreamsCapability",
  type: "rpc",
  worker: { type: "loopback" },
};

const SELF_ADDRESS: CapabilityAddress = {
  type: "rpc",
  worker: { binding: "PROJECT", name: "prj_1", type: "durable-object" },
};

/** An in-memory journal: the only authority, exactly like the real stream. */
function fakeJournal(seed: Array<{ type: string; payload: Record<string, unknown> }> = []) {
  const events: StreamEvent[] = [];
  const push = (event: { type: string; payload: Record<string, unknown> }) => {
    const committed = {
      createdAt: new Date().toISOString(),
      offset: events.length + 1,
      payload: event.payload,
      type: event.type,
    } as StreamEvent;
    events.push(committed);
    return committed;
  };
  for (const event of seed) push(event);
  return {
    events,
    journal: {
      append: async (event: { type: string; payload: Record<string, unknown> }) => {
        return { offset: push(event).offset };
      },
      read: async (input: { afterOffset: number }) =>
        events.filter((event) => event.offset > input.afterOffset),
    },
  };
}

/** A dial that records every (address, attribution, call) and echoes them. */
function fakeDial() {
  const dialed: Array<{
    address: CapabilityAddress;
    attribution: { capabilityPath: string; origin: ItxOrigin };
    call?: { path: string[]; args: unknown[] };
    disposed: boolean;
  }> = [];
  const dial: CapabilityDial = (address, attribution) => {
    const record: (typeof dialed)[number] = { address, attribution, disposed: false };
    dialed.push(record);
    return {
      call: async (input: { path: string[]; args: unknown[] }) => {
        record.call = input;
        return { args: input.args, dialed: address, path: input.path };
      },
      [Symbol.dispose]: () => {
        record.disposed = true;
      },
    };
  };
  return { dial, dialed };
}

function makeItx(
  input: {
    contextId?: string;
    dial?: CapabilityDial;
    journal?: ReturnType<typeof fakeJournal>["journal"];
    parent?: ItxStub | null;
    /** describe()'s label for entries inherited through the parent link. */
    parentFrom?: string;
    runScript?: (input: { code: string; executionId: string }) => Promise<unknown>;
  } = {},
) {
  return new Itx({
    contextId: input.contextId ?? "prj_1",
    dial: input.dial ?? fakeDial().dial,
    iterateContext: { journal: input.journal ?? fakeJournal().journal },
    parentItx: () =>
      input.parent ? { from: input.parentFrom ?? "prj_1", stub: input.parent } : null,
    runScript: input.runScript,
    selfAddress: SELF_ADDRESS,
  });
}

describe("provide + longest-prefix invoke", () => {
  test("dials the entry's address with the path REMAINDER and dial-time attribution", async () => {
    const { dial, dialed } = fakeDial();
    const itx = makeItx({ dial });

    await itx.provideCapability({ capability: AI_ADDRESS, name: "slack" });
    const result = await itx.invoke({ args: [{ text: "hi" }], path: ["slack", "chat", "post"] });

    expect(result).toMatchObject({ path: ["chat", "post"] });
    expect(dialed).toHaveLength(1);
    expect(dialed[0]).toMatchObject({
      address: AI_ADDRESS,
      attribution: { capabilityPath: "slack", origin: { address: SELF_ADDRESS, id: "prj_1" } },
      call: { args: [{ text: "hi" }], path: ["chat", "post"] },
      disposed: true, // the borrow is disposed when the call ends
    });
  });

  test("a path provide shadows ONE subtree; siblings resolve the shorter prefix", async () => {
    const { dial, dialed } = fakeDial();
    const itx = makeItx({ dial });
    await itx.provideCapability({ capability: AI_ADDRESS, name: "sdk" });
    await itx.provideCapability({ capability: LOOPBACK_ADDRESS, path: ["sdk", "chat", "post"] });

    // The shadowed subtree hits the override; the entry path is consumed.
    await itx.invoke({ args: [], path: ["sdk", "chat", "post"] });
    expect(dialed.at(-1)).toMatchObject({
      address: LOOPBACK_ADDRESS,
      attribution: { capabilityPath: "sdk.chat.post" },
      call: { path: [] },
    });

    // A sibling under the same parent misses the override, remainder intact.
    await itx.invoke({ args: [], path: ["sdk", "chat", "update"] });
    expect(dialed.at(-1)).toMatchObject({
      address: AI_ADDRESS,
      call: { path: ["chat", "update"] },
    });
  });

  test("a caller-supplied origin rides into the dial attribution", async () => {
    const { dial, dialed } = fakeDial();
    const itx = makeItx({ dial });
    await itx.provideCapability({ capability: LOOPBACK_ADDRESS, name: "workspace" });

    const origin: ItxOrigin = {
      address: {
        type: "rpc",
        worker: { binding: "ITX_CONTEXT", name: "x", type: "durable-object" },
      },
      id: "itx_child",
    };
    await itx.invoke({ args: [], origin, path: ["workspace", "readFile"] });
    expect(dialed[0]!.attribution).toEqual({ capabilityPath: "workspace", origin });
  });
});

describe("the journal is the only authority", () => {
  test("provides append capability-provided and self-ingest (read-your-writes)", async () => {
    const { events, journal } = fakeJournal();
    const itx = makeItx({ journal });

    await itx.provideCapability({
      capability: AI_ADDRESS,
      instructions: "Workers AI.",
      name: "ai",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      // The JOURNAL record keeps its internal owner field (data) …
      payload: { address: AI_ADDRESS, kind: "rpc", owner: "prj_1", path: ["ai"] },
      type: ITX_EVENT_TYPES.capabilityProvided,
    });
    // … while describe() — the projection — shows an OWN entry with no
    // provenance field at all (`from` is for inherited entries only).
    const described = await itx.describe();
    expect(described).toMatchObject([{ instructions: "Workers AI.", kind: "rpc", name: "ai" }]);
    expect(described[0]).not.toHaveProperty("from");
  });

  test("a fresh instance over the same journal folds to the same state; live entries replay disconnected", async () => {
    const { journal } = fakeJournal();
    const first = makeItx({ journal });
    await first.provideCapability({ capability: AI_ADDRESS, name: "ai" });
    await first.provideCapability({
      capability: { call: async () => "hi" },
      name: "slack",
    });
    expect(await first.describe()).toMatchObject([
      { kind: "rpc", name: "ai" },
      { connected: true, kind: "live", name: "slack" },
    ]);

    // Recovery is replay through the same fold: the capability table comes
    // back verbatim; the live STUB does not (a connection cannot be
    // persisted) — the entry replays as registered-but-offline.
    const second = makeItx({ journal });
    expect(await second.describe()).toMatchObject([
      { kind: "rpc", name: "ai" },
      { connected: false, kind: "live", name: "slack" },
    ]);
    await expect(second.invoke({ args: [], path: ["slack", "post"] })).rejects.toThrow(
      /provider is not connected/,
    );
  });

  test("the birth certificate folds first-wins", () => {
    const initial = { capabilities: {}, context: null, pendingExecutions: {} };
    const born = reduceItxJournalEvent(initial, {
      payload: { id: "itx_a", name: "session", parent: { address: SELF_ADDRESS, id: "prj_1" } },
      type: ITX_EVENT_TYPES.contextCreated,
    });
    expect(born.context).toMatchObject({ id: "itx_a", name: "session", parent: { id: "prj_1" } });
    // A later (retried/duplicate) birth certificate is inert — exactly-once
    // is a property of the fold, not of delivery.
    const again = reduceItxJournalEvent(born, {
      payload: { id: "itx_b", parent: null },
      type: ITX_EVENT_TYPES.contextCreated,
    });
    expect(again.context).toMatchObject({ id: "itx_a" });
  });

  test("malformed journal payloads are ignored by the fold, never wedge it", () => {
    const initial = { capabilities: {}, context: null, pendingExecutions: {} };
    const state = reduceItxJournalEvent(initial, {
      payload: { kind: "worker", name: "legacy-shaped" }, // pre-journal shape: no path
      type: ITX_EVENT_TYPES.capabilityProvided,
    });
    expect(state).toBe(initial);
  });
});

describe("chain delegation", () => {
  function parentStub() {
    return {
      describe: vi.fn(async () => [
        // The parent's own merged view: `ai` arrived from ITS parent (the
        // platform link, already stamped); `inherited` is the parent's own
        // entry, so it carries no provenance field yet.
        { from: "platform", kind: "rpc" as const, meta: {}, name: "ai", updatedAtMs: 0 },
        { kind: "rpc" as const, meta: {}, name: "inherited", updatedAtMs: 1 },
      ]),
      invoke: vi.fn(async () => "from-parent"),
      provideCapability: vi.fn(async () => {}),
      revokeCapability: vi.fn(async () => {}),
    } satisfies ItxStub;
  }

  test("a miss delegates the WHOLE path up with origin ?? self", async () => {
    const parent = parentStub();
    const itx = makeItx({ contextId: "itx_a", parent });

    await expect(itx.invoke({ args: [1], path: ["inherited", "run"] })).resolves.toBe(
      "from-parent",
    );
    expect(parent.invoke).toHaveBeenCalledWith({
      args: [1],
      origin: { address: SELF_ADDRESS, id: "itx_a" },
      path: ["inherited", "run"],
    });

    // A delegated origin is preserved, never overwritten per hop.
    const origin: ItxOrigin = {
      address: {
        type: "rpc",
        worker: { binding: "ITX_CONTEXT", name: "g", type: "durable-object" },
      },
      id: "itx_grandchild",
    };
    await itx.invoke({ args: [], origin, path: ["inherited", "run"] });
    expect(parent.invoke).toHaveBeenLastCalledWith({
      args: [],
      origin,
      path: ["inherited", "run"],
    });
  });

  test("without a parent, a miss throws the instructive error", async () => {
    const itx = makeItx();
    await expect(itx.invoke({ args: [], path: ["nothingHere", "run"] })).rejects.toThrow(
      /No capability named "nothingHere" in context prj_1/,
    );
  });

  test("describe merges the parent chain: own entries unstamped, inherited carry `from`", async () => {
    const parent = parentStub();
    const itx = makeItx({ contextId: "itx_a", parent, parentFrom: "prj_1" });

    // Before any own provide: everything is inherited. A deeper ancestor's
    // stamp ("platform") survives verbatim; the parent's own entry is
    // stamped with this link's label, exactly one level below its owner.
    expect((await itx.describe()).map(({ from, name }) => ({ from, name }))).toEqual([
      { from: "platform", name: "ai" },
      { from: "prj_1", name: "inherited" },
    ]);

    await itx.provideCapability({ capability: AI_ADDRESS, name: "ai" }); // shadows the parent's
    const described = await itx.describe();
    expect(described.map(({ from, name }) => ({ from, name }))).toEqual([
      { from: undefined, name: "ai" }, // own — no provenance field
      { from: "prj_1", name: "inherited" },
    ]);
    expect(described[0]).not.toHaveProperty("from");
  });

  test("platform defaults shadow and resurface as chain consequences", async () => {
    const parent = parentStub();
    const { dial, dialed } = fakeDial();
    const itx = makeItx({ dial, parent });

    // Shadow the inherited default with an own row; lookup never reaches the
    // chain while it exists.
    await itx.provideCapability({ capability: LOOPBACK_ADDRESS, name: "ai" });
    await itx.invoke({ args: [], path: ["ai", "run"] });
    expect(dialed.at(-1)!.address).toEqual(LOOPBACK_ADDRESS);
    expect(parent.invoke).not.toHaveBeenCalled();

    // Revoking the shadow resurfaces the chain — the next lookup delegates.
    await itx.revokeCapability({ name: "ai" });
    await itx.invoke({ args: [], path: ["ai", "run"] });
    expect(parent.invoke).toHaveBeenCalledTimes(1);

    // Revoking the INHERITED entry itself refuses with the shadowing hint.
    await expect(itx.revokeCapability({ name: "ai" })).rejects.toThrow(/platform default/);
    // Revoking something that exists nowhere stays a no-op.
    await expect(itx.revokeCapability({ name: "neverExisted" })).resolves.toBeUndefined();
  });
});

describe("live providers", () => {
  /** A live SDK-shaped provider with the full protocol controls. */
  function liveProvider() {
    const state = { broken: undefined as undefined | ((error: unknown) => void) };
    const disposed: string[] = [];
    const makeStub = (label: string): Record<string, unknown> => ({
      [Symbol.dispose]: () => disposed.push(label),
      call: async (input: { path: string[]; args: unknown[] }) => ({
        from: label,
        method: input.path.join("."),
      }),
      dup: () => makeStub(`${label}+dup`),
      onRpcBroken: (callback: (error: unknown) => void) => {
        if (label === "original+dup") state.broken = callback;
      },
    });
    // A plain object WITHOUT a string `type` is a live capability too (the
    // discriminator only claims plain objects carrying type "rpc"/"url").
    const provider = makeStub("original");
    return { disposed, provider, state };
  }

  test("registers dup-retained, dispatches on a per-call dup, reports connected", async () => {
    const { disposed, provider } = liveProvider();
    const itx = makeItx();
    await itx.provideCapability({ capability: provider, name: "slack" });

    const result = await itx.invoke({ args: [{}], path: ["slack", "chat", "post"] });
    // The borrow is a dup OF the retained dup, and is disposed after the call.
    expect(result).toEqual({ from: "original+dup+dup", method: "chat.post" });
    expect(disposed).toContain("original+dup+dup");
    expect(disposed).not.toContain("original+dup");
    expect(await itx.describe()).toMatchObject([{ connected: true, kind: "live", name: "slack" }]);
  });

  test("a broken session disconnects: the event is journaled, entry survives offline", async () => {
    const { provider, state } = liveProvider();
    const { events, journal } = fakeJournal();
    const itx = makeItx({ journal });
    await itx.provideCapability({ capability: provider, name: "slack" });

    state.broken?.(new Error("session died"));
    await vi.waitFor(() => {
      expect(events.at(-1)).toMatchObject({
        payload: { path: ["slack"] },
        type: ITX_EVENT_TYPES.capabilityDisconnected,
      });
    });
    expect(await itx.describe()).toMatchObject([{ connected: false, name: "slack" }]);
    await expect(itx.invoke({ args: [], path: ["slack", "chat", "post"] })).rejects.toThrow(
      /provider is not connected/,
    );
  });

  test("revoking a live cap disposes the retained stub and journals the revoke", async () => {
    const { disposed, provider } = liveProvider();
    const { events, journal } = fakeJournal();
    const itx = makeItx({ journal });
    await itx.provideCapability({ capability: provider, name: "slack" });
    await itx.revokeCapability({ name: "slack" });
    expect(disposed).toContain("original+dup");
    expect(events.map((event) => event.type)).toEqual([
      ITX_EVENT_TYPES.capabilityProvided,
      ITX_EVENT_TYPES.capabilityRevoked,
    ]);
    expect(await itx.describe()).toEqual([]);
  });
});

describe("bare-function capabilities", () => {
  test("a local bare function auto-wraps: empty remainder calls it, deeper errors", async () => {
    const itx = makeItx();
    const seen: unknown[][] = [];
    await itx.provideCapability({
      capability: async (...args: unknown[]) => {
        seen.push(args);
        return { ok: true };
      },
      name: "probe",
    });

    await expect(itx.invoke({ args: [1, "two"], path: ["probe"] })).resolves.toEqual({ ok: true });
    expect(seen).toEqual([[1, "two"]]);
    // A bare function has no member tree — a deeper path is a plain miss.
    await expect(itx.invoke({ args: [], path: ["probe", "deeper"] })).rejects.toThrow(
      /did not resolve to a function/,
    );
    expect(await itx.describe()).toMatchObject([{ connected: true, kind: "live", name: "probe" }]);
  });
});

describe("plain objects ARE capabilities", () => {
  test("a plain object-of-methods dispatches by member path, at any depth, with no wrapper", async () => {
    const itx = makeItx();
    await itx.provideCapability({
      capability: {
        deep: { thought: (question: string) => ({ answer: 42, question }) },
        ultimate: () => 42,
      },
      name: "answer",
    });

    await expect(itx.invoke({ args: [], path: ["answer", "ultimate"] })).resolves.toBe(42);
    // Depth: the fallthrough replays ["deep", "thought"] onto the object's
    // members — itx.answer.deep.thought("…") with zero client-side wrapping.
    await expect(
      itx.invoke({
        args: ["what do you get if you multiply six by nine"],
        path: ["answer", "deep", "thought"],
      }),
    ).resolves.toEqual({ answer: 42, question: "what do you get if you multiply six by nine" });
    // A member miss inside the object is an instructive path error.
    await expect(itx.invoke({ args: [], path: ["answer", "nope"] })).rejects.toThrow(
      /did not resolve to a function/,
    );
    expect(await itx.describe()).toMatchObject([{ connected: true, kind: "live", name: "answer" }]);
  });

  test("a call-implementing provider still receives ONE call({ path, args }) — members are never traversed", async () => {
    const itx = makeItx();
    const calls: unknown[] = [];
    await itx.provideCapability({
      capability: {
        call: (input: { path: string[]; args: unknown[] }) => {
          calls.push(input);
          return "from-call";
        },
        // A decoy member tree: implementing `call` means the provider owns
        // its whole method-tree semantics, so this must never run.
        chat: { post: () => "member tree, must not run" },
      },
      name: "sdk",
    });

    await expect(
      itx.invoke({ args: [{ text: "hi" }], path: ["sdk", "chat", "post"] }),
    ).resolves.toBe("from-call");
    expect(calls).toEqual([{ args: [{ text: "hi" }], path: ["chat", "post"] }]);
  });
});

describe("processor-mode execution", () => {
  test("an enqueued script-execution-requested runs through the host runner; completed dedupes", async () => {
    const runScript = vi.fn(async () => "ran");
    const { journal } = fakeJournal([
      {
        payload: { code: "async (itx) => 1", enqueued: true, executionId: "exec-1" },
        type: ITX_EVENT_TYPES.scriptExecutionRequested,
      },
      // A pair that already completed in history must NOT re-run on replay.
      {
        payload: { code: "async (itx) => 2", enqueued: true, executionId: "exec-2" },
        type: ITX_EVENT_TYPES.scriptExecutionRequested,
      },
      {
        payload: { executionId: "exec-2", ok: true },
        type: ITX_EVENT_TYPES.scriptExecutionCompleted,
      },
      // Record-only events (the synchronous /api/itx/run door) carry no
      // `enqueued` flag and are never executed by the processor.
      {
        payload: { code: "async (itx) => 3", executionId: "exec-3" },
        type: ITX_EVENT_TYPES.scriptExecutionRequested,
      },
    ]);
    const itx = makeItx({ journal, runScript });
    await itx.describe(); // materialize: consume the journal

    await vi.waitFor(() => {
      expect(runScript).toHaveBeenCalledTimes(1);
    });
    expect(runScript).toHaveBeenCalledWith({ code: "async (itx) => 1", executionId: "exec-1" });
  });
});

describe("structural validation (provide time)", () => {
  test("reserved and non-identifier names refuse", async () => {
    await expect(
      makeItx().provideCapability({ capability: AI_ADDRESS, name: "then" }),
    ).rejects.toThrow(/reserved/);
    await expect(
      makeItx().provideCapability({ capability: AI_ADDRESS, path: ["sdk", "constructor"] }),
    ).rejects.toThrow(/reserved/);
    await expect(
      makeItx().provideCapability({ capability: AI_ADDRESS, name: "not a name" }),
    ).rejects.toThrow(/plain JavaScript identifier/);
    await expect(
      makeItx().provideCapability({ capability: AI_ADDRESS, name: "x", path: ["x"] }),
    ).rejects.toThrow(/exactly one/);
  });

  test("malformed addresses refuse structurally; allowlists do NOT gate provide", async () => {
    await expect(
      makeItx().provideCapability({ capability: { type: "url", url: "not a url" }, name: "x" }),
    ).rejects.toThrow(/not a valid URL/);
    await expect(
      makeItx().provideCapability({
        capability: { type: "rcp", worker: AI_ADDRESS.worker } as never,
        name: "x",
      }),
    ).rejects.toThrow(/unknown target type/);
    await expect(
      makeItx().provideCapability({
        capability: { ...AI_ADDRESS, entrypoint: "Nope" },
        name: "x",
      } as never),
    ).rejects.toThrow(/binding refs take no entrypoint/);
    // Reachability is the dial's authority: providing a non-dialable binding
    // succeeds — the refusal surfaces at first invoke (e2e covers the dial).
    await expect(
      makeItx().provideCapability({
        capability: { type: "rpc", worker: { binding: "DB", type: "binding" } },
        name: "db",
      }),
    ).resolves.toBeUndefined();
  });
});

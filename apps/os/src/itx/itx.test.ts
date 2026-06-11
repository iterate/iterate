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
    runScript?: (input: { code: string; executionId: string }) => Promise<unknown>;
  } = {},
) {
  return new Itx({
    contextId: input.contextId ?? "prj_1",
    dial: input.dial ?? fakeDial().dial,
    iterateContext: { journal: input.journal ?? fakeJournal().journal },
    parentItx: () => input.parent ?? null,
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
      payload: { address: AI_ADDRESS, kind: "rpc", owner: "prj_1", path: ["ai"] },
      type: ITX_EVENT_TYPES.capabilityProvided,
    });
    expect(await itx.describe()).toMatchObject([
      { instructions: "Workers AI.", kind: "rpc", name: "ai", owner: "prj_1" },
    ]);
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
        { kind: "rpc" as const, meta: {}, name: "ai", owner: "platform:project", updatedAtMs: 0 },
        { kind: "rpc" as const, meta: {}, name: "inherited", owner: "prj_1", updatedAtMs: 1 },
      ]),
      invoke: vi.fn(async () => "from-parent"),
      provideCapability: vi.fn(async () => ({})),
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

  test("describe merges the parent chain with exact-match suppression", async () => {
    const parent = parentStub();
    const itx = makeItx({ contextId: "itx_a", parent });
    await itx.provideCapability({ capability: AI_ADDRESS, name: "ai" }); // shadows the parent's

    const described = await itx.describe();
    expect(described.map(({ name, owner }) => ({ name, owner }))).toEqual([
      { name: "ai", owner: "itx_a" },
      { name: "inherited", owner: "prj_1" },
    ]);
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
    // asPathCallable semantics: a bare function has no member tree.
    await expect(itx.invoke({ args: [], path: ["probe", "deeper"] })).rejects.toThrow(
      /did not resolve to a function/,
    );
    expect(await itx.describe()).toMatchObject([{ connected: true, kind: "live", name: "probe" }]);
  });
});

describe("the provision handle", () => {
  test("revoke() removes the entry", async () => {
    const itx = makeItx();
    const provision = await itx.provideCapability({ capability: AI_ADDRESS, name: "extra" });
    await provision.revoke();
    expect(await itx.describe()).toEqual([]);
  });

  test("Symbol.dispose auto-revokes LIVE provides only (a durable disposer is a no-op)", async () => {
    const itx = makeItx();
    // Durable: `using` must NOT undo the provide — session teardown disposes
    // every returned handle, and durable means surviving the session.
    {
      using _durable = await itx.provideCapability({ capability: AI_ADDRESS, name: "durable" });
    }
    expect((await itx.describe()).map((entry) => entry.name)).toEqual(["durable"]);

    // Live: dropping the session would have killed it anyway — dispose makes
    // that explicit and removes the entry.
    {
      using _live = await itx.provideCapability({ capability: async () => "hi", name: "live" });
    }
    await vi.waitFor(async () => {
      expect((await itx.describe()).map((entry) => entry.name)).toEqual(["durable"]);
    });
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
    ).resolves.toBeDefined();
  });
});

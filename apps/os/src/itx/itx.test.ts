// Unit tests for the itx core (itx.ts): one Itx over an in-memory stream
// with a fake dial and a fake parent — no workerd, no SQLite, no streams
// service. This is the workshop's test bed: if a behavior matters to the
// design, it should be provable here — including the stream discipline
// itself (events are the only writes; a fresh instance over the same stream
// folds to the same state).

import { describe, expect, test, vi } from "vitest";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import {
  ITX_EVENT_TYPES,
  Itx,
  reduceItxEvent,
  type CapabilityAddress,
  type CapabilityDial,
  type ItxOrigin,
  type ItxStub,
  type ProvideCapabilityInput,
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

/** An in-memory stream: the only authority, exactly like the real one. */
function fakeStream(seed: Array<{ type: string; payload: Record<string, unknown> }> = []) {
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
    stream: {
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
    contextRef?: string;
    dial?: CapabilityDial;
    stream?: ReturnType<typeof fakeStream>["stream"];
    parent?: ItxStub | null;
    /** describe()'s label for entries inherited through the parent link. */
    parentFrom?: string;
    runScript?: (input: { code: string; executionId: string }) => Promise<unknown>;
  } = {},
) {
  return new Itx({
    contextRef: input.contextRef ?? "prj_1:/",
    dial: input.dial ?? fakeDial().dial,
    iterateContext: { stream: input.stream ?? fakeStream().stream },
    parentItx: () =>
      input.parent ? { from: input.parentFrom ?? "prj_1:/", stub: input.parent } : null,
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
    // ONE dial: provide is a pure append (it never dials), so the only dial
    // is the invoke itself.
    expect(dialed).toHaveLength(1);
    expect(dialed.at(-1)).toMatchObject({
      address: AI_ADDRESS,
      attribution: { capabilityPath: "slack", origin: { address: SELF_ADDRESS, ref: "prj_1:/" } },
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
      ref: "prj_1:/itx/child",
    };
    await itx.invoke({ args: [], origin, path: ["workspace", "readFile"] });
    expect(dialed.at(-1)!.attribution).toEqual({ capabilityPath: "workspace", origin });
  });
});

describe("provide is a pure stream append (no provider-code calls)", () => {
  test("a typeless rpc provide dials NOTHING — provide never calls the target", async () => {
    // Regression: a provide-time describeItx probe re-entered an agent's own
    // Durable Object mid-wake and broke agents in prod. provide must append
    // and return; the target is only dialed on invoke. Self-description is
    // caller-supplied (instructions/types at provide time).
    const dial = vi.fn();
    const itx = makeItx({ dial: dial as unknown as CapabilityDial });
    await itx.provideCapability({ capability: AI_ADDRESS, name: "ai" });
    await itx.provideCapability({ capability: LOOPBACK_ADDRESS, name: "petstore" });
    expect(dial).not.toHaveBeenCalled();
    expect(await itx.describe()).toMatchObject([
      { name: "ai", types: undefined },
      { name: "petstore", types: undefined },
    ]);
  });

  test("caller-supplied instructions + types are recorded verbatim", async () => {
    const { events, stream } = fakeStream();
    const itx = makeItx({ stream });
    await itx.provideCapability({
      capability: LOOPBACK_ADDRESS,
      instructions: "Petstore. listOperations() first.",
      name: "petstore",
      types: "declare function findPetsByStatus(input: { status: string }): Promise<unknown>;",
    });
    expect(events[0]!.payload).toMatchObject({
      meta: {
        instructions: "Petstore. listOperations() first.",
        types: expect.stringContaining("declare function findPetsByStatus"),
      },
    });
  });

  test("live provides are never dialed", async () => {
    const dial = vi.fn();
    const itx = makeItx({ dial: dial as unknown as CapabilityDial });
    await itx.provideCapability({ capability: { run: async () => 1 }, name: "live" });
    expect(dial).not.toHaveBeenCalled();
  });

  test("describeItx is reserved: not as a capability path, not as a dispatch segment", async () => {
    const itx = makeItx();
    await expect(
      itx.provideCapability({ capability: AI_ADDRESS, name: "describeItx" }),
    ).rejects.toThrow(/reserved/);
    await expect(
      itx.provideCapability({ capability: AI_ADDRESS, path: ["x", "describeItx"] }),
    ).rejects.toThrow(/reserved/);
  });
});

describe("the stream is the only authority", () => {
  test("provides append capability-provided and self-ingest (read-your-writes)", async () => {
    const { events, stream } = fakeStream();
    const itx = makeItx({ stream });

    await itx.provideCapability({
      capability: AI_ADDRESS,
      instructions: "Workers AI.",
      name: "ai",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      // The stream record keeps its internal owner field (data) …
      payload: { address: AI_ADDRESS, kind: "rpc", owner: "prj_1:/", path: ["ai"] },
      type: ITX_EVENT_TYPES.capabilityProvided,
    });
    // … while describe() — the projection — shows an OWN entry with no
    // provenance field at all (`from` is for inherited entries only).
    const described = await itx.describe();
    expect(described).toMatchObject([{ instructions: "Workers AI.", kind: "rpc", name: "ai" }]);
    expect(described[0]).not.toHaveProperty("from");
  });

  test("a fresh instance over the same stream folds to the same state; live entries replay disconnected", async () => {
    const { stream } = fakeStream();
    const first = makeItx({ stream });
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
    const second = makeItx({ stream });
    expect(await second.describe()).toMatchObject([
      { kind: "rpc", name: "ai" },
      { connected: false, kind: "live", name: "slack" },
    ]);
    await expect(second.invoke({ args: [], path: ["slack", "post"] })).rejects.toThrow(
      /provider is not connected/,
    );
  });

  test("an rpc cap survives a COLD restart through a persisted checkpoint (host wiring)", async () => {
    // The host wires the Itx checkpoint to durable storage (readState/
    // writeState). This reproduces that EXACT wiring: provide on a warm
    // instance, then build a FRESH instance from the SAME stream AND the
    // SAME persisted checkpoint — the way a Durable Object comes back after
    // eviction. The rpc cap must resolve, not vanish.
    const { stream } = fakeStream();
    let checkpoint: { offset: number; state: Itx["state"] } | undefined;
    const CHAT_ADDRESS: CapabilityAddress = {
      entrypoint: "AgentToolsCapability",
      props: { agentPath: "/agents/asdasdasd", tool: "chat" },
      type: "rpc",
      worker: { type: "loopback" },
    };
    const build = (dial: CapabilityDial) =>
      new Itx({
        contextRef: "prj_1:/agents/asdasdasd",
        dial,
        iterateContext: { stream },
        parentItx: () => null,
        readState: async () => checkpoint,
        selfAddress: SELF_ADDRESS,
        writeState: async (snapshot) => {
          checkpoint = snapshot as { offset: number; state: Itx["state"] };
        },
      });

    const warm = build(fakeDial().dial);
    await warm.provideCapability({
      capability: CHAT_ADDRESS,
      instructions: "Reply to the user.",
      name: "chat",
    });
    // The provide must have flushed a checkpoint carrying the cap.
    expect(checkpoint?.state.capabilities.chat).toMatchObject({ kind: "rpc", name: "chat" });

    // Cold restart: a brand-new instance over the same stream + checkpoint.
    const { dial, dialed } = fakeDial();
    const cold = build(dial);
    await cold.invoke({ args: [{ message: "hi" }], path: ["chat", "sendMessage"] });
    expect(dialed.at(-1)).toMatchObject({
      address: CHAT_ADDRESS,
      call: { path: ["sendMessage"] },
    });
  });

  test("the creation event folds first-wins (get-or-create)", () => {
    const initial = { capabilities: {}, context: null, pendingExecutions: {} };
    const born = reduceItxEvent(initial, {
      payload: { name: "session", parent: { address: SELF_ADDRESS, ref: "prj_1:/" } },
      type: ITX_EVENT_TYPES.contextCreated,
    });
    expect(born.context).toMatchObject({ name: "session", parent: { ref: "prj_1:/" } });
    // A later (retried/re-created) creation event is inert — exactly-once
    // is a property of the fold, not of delivery.
    const again = reduceItxEvent(born, {
      payload: { name: "other", parent: null },
      type: ITX_EVENT_TYPES.contextCreated,
    });
    expect(again.context).toMatchObject({ name: "session" });
  });

  test("malformed stream payloads are ignored by the fold, never wedge it", () => {
    const initial = { capabilities: {}, context: null, pendingExecutions: {} };
    const state = reduceItxEvent(initial, {
      payload: { kind: "worker", name: "legacy-shaped" }, // pre-stream shape: no path
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
        // defaults link, already stamped); `inherited` is the parent's own
        // entry, so it carries no provenance field yet.
        { from: "defaults", kind: "rpc" as const, meta: {}, name: "ai", updatedAtMs: 0 },
        { kind: "rpc" as const, meta: {}, name: "inherited", updatedAtMs: 1 },
      ]),
      invoke: vi.fn(async () => "from-parent"),
      provideCapability: vi.fn(async () => {}),
      revokeCapability: vi.fn(async () => {}),
    } satisfies ItxStub;
  }

  test("a miss delegates the WHOLE path up with origin ?? self", async () => {
    const parent = parentStub();
    const itx = makeItx({ contextRef: "prj_1:/itx/a", parent });

    await expect(itx.invoke({ args: [1], path: ["inherited", "run"] })).resolves.toBe(
      "from-parent",
    );
    expect(parent.invoke).toHaveBeenCalledWith({
      args: [1],
      origin: { address: SELF_ADDRESS, ref: "prj_1:/itx/a" },
      path: ["inherited", "run"],
    });

    // A delegated origin is preserved, never overwritten per hop.
    const origin: ItxOrigin = {
      address: {
        type: "rpc",
        worker: { binding: "ITX_CONTEXT", name: "g", type: "durable-object" },
      },
      ref: "prj_1:/itx/grandchild",
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
    const itx = makeItx({ contextRef: "prj_1:/itx/a", parent, parentFrom: "prj_1" });

    // Before any own provide: everything is inherited. A deeper ancestor's
    // stamp ("defaults") survives verbatim; the parent's own entry is
    // stamped with this link's label, exactly one level below its owner.
    expect((await itx.describe()).map(({ from, name }) => ({ from, name }))).toEqual([
      { from: "defaults", name: "ai" },
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

  test("the defaults shadow and resurface as chain consequences", async () => {
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
    await expect(itx.revokeCapability({ name: "ai" })).rejects.toThrow(
      /inherited from the defaults/,
    );
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

  test("a broken session disconnects: the event is recorded, entry survives offline", async () => {
    const { provider, state } = liveProvider();
    const { events, stream } = fakeStream();
    const itx = makeItx({ stream });
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

  test("revoking a live cap disposes the retained stub and records the revoke", async () => {
    const { disposed, provider } = liveProvider();
    const { events, stream } = fakeStream();
    const itx = makeItx({ stream });
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

  test("member stubs are dup-retained at registration; revoke releases exactly the dups", async () => {
    // Plain objects cross RPC by value with their function members as
    // session stubs, and RPC disposes argument stubs when the provide call
    // returns — so the core must store DUPS of the members, never the
    // originals. This fake mirrors a member stub's protocol surface.
    const disposed: string[] = [];
    const memberStub = (label: string) => {
      const fn = (...args: unknown[]) => ({ args, from: label });
      return Object.assign(fn, {
        dup: () => memberStub(`${label}+dup`),
        [Symbol.dispose]: () => disposed.push(label),
      });
    };
    const ultimate = memberStub("ultimate");
    const thought = memberStub("thought");
    const itx = makeItx();
    await itx.provideCapability({
      capability: { deep: { thought }, ultimate },
      name: "answer",
    });

    // Simulate the RPC layer disposing the provide call's argument stubs.
    ultimate[Symbol.dispose]();
    thought[Symbol.dispose]();
    // Dispatch runs on the retained dups, at any depth.
    await expect(itx.invoke({ args: [1], path: ["answer", "ultimate"] })).resolves.toEqual({
      args: [1],
      from: "ultimate+dup",
    });
    await expect(itx.invoke({ args: [], path: ["answer", "deep", "thought"] })).resolves.toEqual({
      args: [],
      from: "thought+dup",
    });

    // Revoke releases exactly what registration dup'd — nothing else.
    await itx.revokeCapability({ name: "answer" });
    expect(disposed).toEqual(["ultimate", "thought", "thought+dup", "ultimate+dup"]);
  });

  test("members survive a REAL capnweb session's provide (argument stubs die at call end)", async () => {
    const itx = makeItx();
    // The context node's protocol surface, exposed over a real Cap'n Web
    // session pair (in-memory MessagePorts — same wire discipline as the
    // WebSocket sessions production uses).
    class CoreMain extends RpcTarget {
      provideCapability(input: ProvideCapabilityInput) {
        return itx.provideCapability(input);
      }
      invoke(input: { path: string[]; args: unknown[] }) {
        return itx.invoke(input);
      }
    }
    const channel = new MessageChannel();
    try {
      newMessagePortRpcSession(channel.port1 as never, new CoreMain());
      const remote = newMessagePortRpcSession<CoreMain>(channel.port2 as never);
      await remote.provideCapability({
        capability: {
          deep: { thought: async (question: string) => ({ answer: 42, question }) },
          ultimate: () => 42,
        },
        name: "answer",
      } as never);

      // The provide RPC has RETURNED — capnweb disposed its argument stubs.
      // Dispatch must run on the core's retained dups, back in the provider.
      await expect(remote.invoke({ args: [], path: ["answer", "ultimate"] })).resolves.toBe(42);
      await expect(
        remote.invoke({ args: ["life"], path: ["answer", "deep", "thought"] }),
      ).resolves.toEqual({ answer: 42, question: "life" });
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
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
    const { stream } = fakeStream([
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
    const itx = makeItx({ stream, runScript });
    await itx.describe(); // materialize: consume the stream

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
    // "url" was an address kind once (UrlDial, deleted); now it refuses like
    // any other unknown type instead of registering an offline live cap.
    await expect(
      makeItx().provideCapability({
        capability: { type: "url", url: "https://example.com" } as never,
        name: "x",
      }),
    ).rejects.toThrow(/unknown target type/);
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

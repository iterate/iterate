// Unit tests for the PURE itx core (itx.ts): construct an Itx with a fake
// dial and exercise the whole structural surface — no workerd, no SQLite, no
// streams. This is the workshop's test bed: if a behavior matters to the
// design, it should be provable here.

import { describe, expect, test, vi } from "vitest";
import { Itx, type CapabilityAddress, type CapabilityDial, type ItxStub } from "./itx.ts";

const AI_ADDRESS: CapabilityAddress = {
  type: "rpc",
  worker: { binding: "AI", type: "binding" },
};

const LOOPBACK_ADDRESS: CapabilityAddress = {
  entrypoint: "StreamsCapability",
  type: "rpc",
  worker: { type: "loopback" },
};

/** A dial that records every (address, attribution, call) and echoes them. */
function fakeDial() {
  const dialed: Array<{
    address: CapabilityAddress;
    attribution: { capabilityPath: string; origin: string };
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

describe("provide + longest-prefix invoke", () => {
  test("dials the entry's address with the path REMAINDER and dial-time attribution", async () => {
    const { dial, dialed } = fakeDial();
    const itx = new Itx({ contextId: "prj_1", dial });

    itx.provideCapability({ name: "slack", capability: AI_ADDRESS });
    const result = await itx.invoke({ args: [{ text: "hi" }], path: ["slack", "chat", "post"] });

    expect(result).toMatchObject({ path: ["chat", "post"] });
    expect(dialed).toHaveLength(1);
    expect(dialed[0]).toMatchObject({
      address: AI_ADDRESS,
      attribution: { capabilityPath: "slack", origin: "prj_1" },
      call: { args: [{ text: "hi" }], path: ["chat", "post"] },
      disposed: true, // the borrow is disposed when the call ends
    });
  });

  test("a path define shadows ONE subtree; siblings resolve the shorter prefix", async () => {
    const { dial, dialed } = fakeDial();
    const itx = new Itx({ contextId: "prj_1", dial });
    itx.provideCapability({ name: "sdk", capability: AI_ADDRESS });
    itx.provideCapability({ path: ["sdk", "chat", "post"], capability: LOOPBACK_ADDRESS });

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
    const itx = new Itx({ contextId: "prj_1", dial });
    itx.provideCapability({ name: "workspace", capability: LOOPBACK_ADDRESS });

    await itx.invoke({ args: [], origin: "ctx_child", path: ["workspace", "readFile"] });
    expect(dialed[0]!.attribution).toEqual({ capabilityPath: "workspace", origin: "ctx_child" });
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
      provideCapability: vi.fn(async () => {}),
      revokeCapability: vi.fn(async () => {}),
    } satisfies ItxStub;
  }

  test("a miss delegates the WHOLE path up with origin ?? contextId", async () => {
    const parent = parentStub();
    const itx = new Itx({ contextId: "ctx_a", dial: fakeDial().dial, parentItx: parent });

    await expect(itx.invoke({ args: [1], path: ["inherited", "run"] })).resolves.toBe(
      "from-parent",
    );
    expect(parent.invoke).toHaveBeenCalledWith({
      args: [1],
      origin: "ctx_a",
      path: ["inherited", "run"],
    });

    // A delegated origin is preserved, never overwritten per hop.
    await itx.invoke({ args: [], origin: "ctx_grandchild", path: ["inherited", "run"] });
    expect(parent.invoke).toHaveBeenLastCalledWith({
      args: [],
      origin: "ctx_grandchild",
      path: ["inherited", "run"],
    });
  });

  test("without a parent, a miss throws the instructive error", async () => {
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    await expect(itx.invoke({ args: [], path: ["nothingHere", "run"] })).rejects.toThrow(
      /No capability named "nothingHere" in context prj_1/,
    );
  });

  test("describe merges the parent chain with exact-match suppression", async () => {
    const parent = parentStub();
    const itx = new Itx({ contextId: "ctx_a", dial: fakeDial().dial, parentItx: parent });
    itx.provideCapability({ name: "ai", capability: AI_ADDRESS }); // shadows the parent's

    const described = await itx.describe();
    expect(described.map(({ name, owner }) => ({ name, owner }))).toEqual([
      { name: "ai", owner: "ctx_a" },
      { name: "inherited", owner: "prj_1" },
    ]);
  });
});

describe("constructor defaults + describe provenance + revoke", () => {
  function withDefaults() {
    const { dial, dialed } = fakeDial();
    const itx = new Itx({
      capabilities: [{ instructions: "Workers AI.", name: "ai", capability: AI_ADDRESS }],
      contextId: "prj_1",
      dial,
    });
    return { dialed, itx };
  }

  test("defaults carry the constructor owner and updatedAtMs 0; instructions lift", async () => {
    const { itx } = withDefaults();
    expect(await itx.describe()).toMatchObject([
      {
        instructions: "Workers AI.",
        kind: "rpc",
        name: "ai",
        owner: "platform:project",
        updatedAtMs: 0,
      },
    ]);
  });

  test("a runtime provide shadows the default (one entry, runtime owner)", async () => {
    const { itx } = withDefaults();
    itx.provideCapability({ name: "ai", capability: LOOPBACK_ADDRESS });
    const described = await itx.describe();
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ name: "ai", owner: "prj_1" });
  });

  test("revoking the default itself refuses; revoking a shadow resurfaces it", async () => {
    const { dialed, itx } = withDefaults();
    expect(() => itx.revokeCapability({ name: "ai" })).toThrow(/platform default/);

    itx.provideCapability({ name: "ai", capability: LOOPBACK_ADDRESS });
    itx.revokeCapability({ name: "ai" });
    expect(await itx.describe()).toMatchObject([{ name: "ai", owner: "platform:project" }]);
    await itx.invoke({ args: [], path: ["ai", "run"] });
    expect(dialed.at(-1)!.address).toEqual(AI_ADDRESS);
  });

  test("revoking a non-default entry deletes it; revoking nothing is a no-op", async () => {
    const { itx } = withDefaults();
    itx.provideCapability({ name: "extra", capability: LOOPBACK_ADDRESS });
    itx.revokeCapability({ name: "extra" });
    itx.revokeCapability({ name: "neverExisted" });
    expect((await itx.describe()).map((cap) => cap.name)).toEqual(["ai"]);
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
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    itx.provideCapability({ name: "slack", capability: provider });

    const result = await itx.invoke({ args: [{}], path: ["slack", "chat", "post"] });
    // The borrow is a dup OF the retained dup, and is disposed after the call.
    expect(result).toEqual({ from: "original+dup+dup", method: "chat.post" });
    expect(disposed).toContain("original+dup+dup");
    expect(disposed).not.toContain("original+dup");
    expect(await itx.describe()).toMatchObject([{ connected: true, kind: "live", name: "slack" }]);
  });

  test("a broken session disconnects: entry survives, invoke throws offline", async () => {
    const { provider, state } = liveProvider();
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    itx.provideCapability({ name: "slack", capability: provider });

    state.broken?.(new Error("session died"));
    expect(await itx.describe()).toMatchObject([{ connected: false, name: "slack" }]);
    await expect(itx.invoke({ args: [], path: ["slack", "chat", "post"] })).rejects.toThrow(
      /provider is not connected/,
    );
  });

  test("revoking a live cap disposes the retained stub", () => {
    const { disposed, provider } = liveProvider();
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    itx.provideCapability({ name: "slack", capability: provider });
    itx.revokeCapability({ name: "slack" });
    expect(disposed).toContain("original+dup");
  });
});

describe("bare-function capabilities", () => {
  test("a local bare function auto-wraps: empty remainder calls it, deeper errors", async () => {
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    const seen: unknown[][] = [];
    itx.provideCapability({
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
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    const provision = itx.provideCapability({ capability: AI_ADDRESS, name: "extra" });
    await provision.revoke();
    expect(await itx.describe()).toEqual([]);
  });

  test("Symbol.dispose auto-revokes LIVE provides only (a durable disposer is a no-op)", async () => {
    const itx = new Itx({ contextId: "prj_1", dial: fakeDial().dial });
    // Durable: `using` must NOT undo the provide — session teardown disposes
    // every returned handle, and durable means surviving the session.
    {
      using _durable = itx.provideCapability({ capability: AI_ADDRESS, name: "durable" });
    }
    expect((await itx.describe()).map((cap) => cap.name)).toEqual(["durable"]);

    // Live: dropping the session would have killed it anyway — dispose makes
    // that explicit and removes the entry.
    {
      using _live = itx.provideCapability({ capability: async () => "hi", name: "live" });
    }
    await Promise.resolve(); // the disposer's revoke is fire-and-forget
    expect((await itx.describe()).map((cap) => cap.name)).toEqual(["durable"]);
  });
});

describe("structural validation (provide time)", () => {
  const itx = () => new Itx({ contextId: "prj_1", dial: fakeDial().dial });

  test("reserved and non-identifier names refuse", () => {
    expect(() => itx().provideCapability({ name: "then", capability: AI_ADDRESS })).toThrow(
      /reserved/,
    );
    expect(() =>
      itx().provideCapability({ path: ["sdk", "constructor"], capability: AI_ADDRESS }),
    ).toThrow(/reserved/);
    expect(() => itx().provideCapability({ name: "not a name", capability: AI_ADDRESS })).toThrow(
      /plain JavaScript identifier/,
    );
    expect(() =>
      itx().provideCapability({ name: "x", path: ["x"], capability: AI_ADDRESS }),
    ).toThrow(/exactly one/);
  });

  test("malformed addresses refuse structurally; allowlists do NOT gate provide", () => {
    expect(() =>
      itx().provideCapability({ name: "x", capability: { type: "url", url: "not a url" } }),
    ).toThrow(/not a valid URL/);
    expect(() =>
      itx().provideCapability({
        name: "x",
        capability: { type: "rcp", worker: AI_ADDRESS.worker } as never,
      }),
    ).toThrow(/unknown target type/);
    expect(() =>
      itx().provideCapability({
        entrypoint: "Nope",
        name: "x",
        capability: { ...AI_ADDRESS, entrypoint: "Nope" },
      } as never),
    ).toThrow(/binding refs take no entrypoint/);
    // Reachability is the dial's authority: providing a non-dialable binding
    // succeeds — the refusal surfaces at first invoke (e2e covers the dial).
    expect(() =>
      itx().provideCapability({
        name: "db",
        capability: { type: "rpc", worker: { binding: "DB", type: "binding" } },
      }),
    ).not.toThrow();
  });
});

// __tests__/failing-dotted-surface.test.ts — BUG HUNT: the NATURAL DOTTED CLIENT SURFACE.
//
// In apps/os a client speaks deep dotted itx expressions as PLAIN PROPERTY ACCESS on the
// capnweb stub — `itx.slack.chat.postMessage({...})`, `itx.kv.put('k','v')` — even though only
// fixed members are real methods anywhere along the path: a prototype-hop fallback turns every
// unknown segment into an accumulated `invokeCapability({ path, args })` dispatch
// (apps/os/src/domains/itx/utils.ts installPrototypeInvokeCapabilityFallback +
// createInvokeCapabilityPathProxy; server replay + miss grammar in apps/os/src/itx/path-proxy.ts).
// That surface is proven by apps/os/src/domains/itx/path-proxy.test.ts and the live slack shape
// in apps/os/src/domains/integrations/slack-api.test.ts.
//
// In THIS clean room the client is JUST capnweb (itx-surface.ts invariant) and the IterateContext
// RpcTarget answers only its fixed methods (invokeCapability / invoke / provide / …), so the
// natural dotted spelling is expected to be MISSING today. Every test below asserts the
// CORRECT (apps/os-proven) behavior, adapted to our built-ins (whoami / kv / append / read)
// and our live-bridge shape (proofs/prove_slack.mjs); genuinely-failing ones are
// `test.fails` with BUG/EXPECTED/ACTUAL/WHY blocks. Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-dotted-surface.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { enableFixtureProcessor } from "../e2e/support/sources.ts";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_fd${RUN}_${name}`;

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── helpers ──

/** Poll until `fn` returns truthy (deadline, never a bare sleep). Returns the truthy value. */
async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = `falsy: ${JSON.stringify(v)}`;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline)
      throw new Error(`until(${label}): deadline after ${timeoutMs}ms — last: ${String(last)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Await a promise that MUST reject promptly; hands back the rejection error. Throws if it
 *  resolves or is still pending at the deadline (a hang is a bug, never a wait). */
async function rejectionOf(
  p: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const settled = p.then(
    (v) => ({ kind: "resolved" as const, v }),
    (e) => ({ kind: "rejected" as const, e }),
  );
  const HUNG = { kind: "hung" as const };
  const out = await Promise.race([
    settled,
    new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), timeoutMs)),
  ]);
  if (out.kind === "hung")
    throw new Error(`${label}: still pending after ${timeoutMs}ms — expected a prompt rejection`);
  if (out.kind === "resolved")
    throw new Error(`${label}: resolved (${JSON.stringify(out.v)}) — expected a rejection`);
  return out.e;
}

const messageOf = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as Error).message) : String(e);

/** A live client capability (the failing-connections.test.ts rig). */
class Tools extends RpcTarget {
  #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  hello() {
    return `hello-from-${this.#tag}`;
  }
}

/** The prove_slack.mjs bridge: an RpcTarget that replays dotted calls onto a WebClient-shaped
 *  SDK (recorded here; swap in `new WebClient(token)` for real). */
class SlackReplayTarget extends RpcTarget {
  #calls: Array<[string, Record<string, unknown>]>;
  constructor(calls: Array<[string, Record<string, unknown>]>) {
    super();
    this.#calls = calls;
  }
  get chat() {
    return {
      postMessage: async (opts: Record<string, unknown>) => {
        this.#calls.push(["chat.postMessage", opts]);
        return { ok: true, ts: "1755.000100", channel: opts.channel };
      },
    };
  }
}

/** Attach a slack bridge to `ctx` and hand back an ordinary second client (prove_slack.mjs:71-98
 *  shape: provider session + consumer session over the same context). The bridge is a LIVE
 *  capability provided AT `itx.slack` — the mount path IS its identity — so every other client
 *  just speaks `itx.slack.chat.postMessage(...)`. */
async function slackRig(ctx: string) {
  const sdkCalls: Array<[string, Record<string, unknown>]> = [];
  const bridgeItx = await harness.itx(ctx);
  await bridgeItx.provide("itx.slack", new SlackReplayTarget(sdkCalls));
  const itx = await harness.itx(ctx);
  // Sanity through the EXPLICIT door — the mount is live before any dotted attempt.
  await until("slack mount routable via the explicit door", async () => {
    const posted: any = await itx.invokeCapability([
      "itx",
      "slack",
      "chat",
      ["postMessage", { channel: "#sanity", text: "rig up" }],
    ]);
    return posted?.ok === true;
  });
  sdkCalls.length = 0; // the sanity call is rig noise, not test data
  return { itx, sdkCalls };
}

/** Provide a live Tools capability at `itx.<name>` and wait until it answers via the STRING
 *  door (the door that provably works today). */
async function connectedRig(ctx: string, name: string) {
  const itx = await harness.itx(ctx);
  const s = harness.session();
  await s.authenticate().projects.get(ctx).provide(`itx.${name}`, new Tools(name));
  await until(`live capability 'itx.${name}' answers via the string door`, async () => {
    return (await itx.invokeCapability(`itx.${name}.hello()`)) === `hello-from-${name}`;
  });
  return itx;
}

// ── the explicit doors (the working baseline the dotted surface must sugar) ──

// ADAPTED FROM apps/os/src/domains/itx/path-proxy.test.ts:50-54 ("keeps real RpcTarget members
// …"): declared members must keep answering when a dotted fallback exists — pinned here first
// so every test.fails below is a missing-sugar bug, never a broken door.
test("explicit door: invokeCapability(['whoami']) answers (the half the dotted surface sugars)", async () => {
  const itx = await harness.itx(c("door"));
  const who = await itx.invokeCapability(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: c("door"), path: "/" });
});

// ADAPTED FROM proofs/prove_slack.mjs:84-98 + apps/os/src/domains/integrations/slack-api.test.ts:60-74
// (a WebClient-shaped call rides the project surface end to end): the deep live-bridge replay
// works TODAY through the explicit door — the dotted spelling below is pure client sugar.
test("explicit door: deep slack replay through a live bridge works today", async () => {
  const { itx, sdkCalls } = await slackRig(c("sdoor"));
  const posted: any = await itx.invokeCapability([
    "itx",
    "slack",
    "chat",
    ["postMessage", { channel: "#general", text: "hello from itx" }],
  ]);
  expect(posted).toMatchObject({ ok: true, ts: "1755.000100", channel: "#general" });
  expect(sdkCalls).toEqual([["chat.postMessage", { channel: "#general", text: "hello from itx" }]]);
});

// ── the natural dotted surface (apps/os-proven; missing here) ──

// BUG: the IterateContext RpcTarget (src/core/itx-surface.ts) answers ONLY its fixed methods — there is no
//   prototype-hop / path-proxy fallback, so an unknown dotted root never becomes an
//   invokeCapability dispatch.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:50-61 "falls back only for unknown
//   paths"): `itx.whoami()` = sugar for invokeCapability(["itx", ["whoami"]]) →
//   { projectId, path: "/" }.
// ACTUAL: rejects with capnweb's raw follow-path error — TypeError: 'whoami' is not a
//   function. (own props: { remote: true }, no code) — nothing ever reaches the capability table.
// WHY IT MATTERS: this spelling is the ONE calling convention every apps/os client, agent
//   prompt, and doc teaches; without the fallback the clean room's dotted door exists only
//   server-side (invokeCapability), and every ported client breaks on its first call.
test("root dotted call: await itx.whoami() falls back to the capability table", async () => {
  const itx = await harness.itx(c("who"));
  const who = await itx.whoami();
  expect(who).toMatchObject({ projectId: c("who"), path: "/" });
});

// BUG: same missing fallback, one level deeper — `kv` resolves to undefined ON the IterateContext
//   RpcTarget and the follow-path walk explodes on the next segment.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:55-56 — stub.nested.math.add /
//   stub.tools.greeter.sayHello accumulate path segments and dispatch once): itx.kv.put →
//   invokeCapability(["itx", "kv", ["put", "k","v"]]) → { ok: true }; itx.kv.get → "v".
//   The explicit door proves the capability itself works (DEFAULT_CONFIG_MOUNTS mounts itx.kv).
// ACTUAL: rejects with TypeError: Cannot read properties of undefined (reading 'put') — a raw
//   JS property miss on the server, uncoded ({ remote: true } only).
// WHY IT MATTERS: depth-2 built-ins (kv, secrets) are the bread-and-butter calls; the
//   error also violates core/errors.ts (nothing machine-readable rides it).
test("depth-2 dotted: itx.kv.put('k','v') then itx.kv.get('k') round trips", async () => {
  const itx = await harness.itx(c("kv"));
  expect(await itx.kv.put("k", "v")).toMatchObject({ ok: true });
  expect(await itx.kv.get("k")).toBe("v");
});

// FIXED (was: the dotted spelling of the commonest write did not exist; then it rode the
//   prototype fallback as `itx.stream.append`). The flattening moved the stream verbs to the TOP
//   level on BOTH surfaces: `itx.append(...)` here is the DECLARED IterateContext method (the
//   direct lane — core/itx-surface.ts), and the read stays an EXPRESSION so the builtin `read`
//   ROOT keeps resolver coverage (built-ins.ts own-key + Object.hasOwn gate). One log serves both.
test("direct write, expression read: itx.append lands in the ONE log", async () => {
  const itx = await harness.itx(c("stream"));
  const [committed] = await itx.append({ type: "mark", payload: { n: 1 } });
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page: any = await itx.invokeCapability(["itx", ["read"]]);
  expect(page.events.some((e: any) => e.type === "mark")).toBe(true);
});

// The dotted spelling of a live capability: the client just speaks the mount path (`itx.b.hello()`
// — ONE invokeCapability fold). The mount is pure data whose TARGET names the physical registry
// (`itx.rpcStubs.get('itx.b')`); the resolver evaluates that target against the built-in and its
// InvokeHandle pipelines the `.hello()` remainder into one DO-side dispatch. The registry spelling
// `itx.rpcStubs.get('itx.b').hello()` is therefore not dead — it is the mount's target, and a valid
// direct call in its own right (one round trip; the mid-chain-pipelining property stays pinned on
// the handle chains in __workers-tests__/rpc-pipelining.test.ts + e2e/dw2dw — load/facets handles).
test("dotted call through the mount path: itx.b.hello() answers from a live capability", async () => {
  const itx = await connectedRig(c("conn"), "b");
  expect(await itx.b.hello()).toBe("hello-from-b");
});

// BUG: the flagship use case — a WebClient-shaped SDK behind a live bridge — has no dotted
//   client spelling; only the explicit door works (proven by the plain test above).
// EXPECTED (apps/os/src/domains/integrations/slack-api.test.ts:60-74 — the itx caller surface
//   IS `…chat.postMessage({...})`; proofs/prove_slack.mjs:84-98 — same call via the explicit
//   door): `itx.slack.chat.postMessage({...})` → { ok: true, … } and the bridge-side SDK
//   receives the exact call.
// ACTUAL: rejects with TypeError: Cannot read properties of undefined (reading 'chat') — the
//   walk dies on `slack` being undefined on the IterateContext RpcTarget; the bridge never hears anything.
// WHY IT MATTERS: "every other client of the project then just speaks
//   itx.slack.chat.postMessage(...)" is prove_slack.mjs's OWN promise (line 5) — today that
//   sentence is only true for callers willing to hand-build { path, args }.
test("slack-style deep SDK replay: itx.slack.chat.postMessage({...})", async () => {
  const { itx, sdkCalls } = await slackRig(c("slack"));
  const posted: any = await itx.slack.chat.postMessage({ channel: "#dotted", text: "sugar" });
  expect(posted).toMatchObject({ ok: true, channel: "#dotted" });
  expect(sdkCalls).toEqual([["chat.postMessage", { channel: "#dotted", text: "sugar" }]]);
});

// A wrong guess at a dotted surface (`itx.slack.api.postMessage` — the invented `.api.` namespace
//   from slack-api.test.ts's own fixture) REACHES the capability table (the hop landed), dispatches
//   invokeCapability(["itx", "slack", "api", ["postMessage"]]), routes through the parked-connection
//   relay, and the remote SlackReplayTarget's absent `.api` surfaces as a raw JS TypeError inside
//   RetainedCallbackInvoker.invoke (core/itx-surface.ts). We propagate that reject as-is — the
//   NOT_A_METHOD re-grammar (an apps/os error-normalizer nicety) has no clean-room consumer.
test("a dotted mid-path miss REJECTS (the invented namespace resolves to nothing callable)", async () => {
  const { itx } = await slackRig(c("miss"));
  // The NOT_A_METHOD re-grammar was removed (an apps/os error-normalizer nicety with no clean-room
  // consumer). A wrong guess at a live provider's surface now propagates the RAW capnweb reject — it
  // still ERRORS (that's the contract), just without the re-grammared "did not resolve to a function".
  const err = await rejectionOf(
    itx.slack.api.postMessage({ channel: "#x", text: "y" }),
    15_000,
    "dotted call through an invented namespace",
  );
  expect(messageOf(err)).toBeTruthy();
});

// A leaf miss through the WORKING explicit door also just REJECTS. invokeCapability routes through
//   the parked-connection relay; the remote SlackReplayTarget's `chat` exists but `.nosuchMethod`
//   does not, so capnweb rejects with a raw TypeError inside RetainedCallbackInvoker.invoke. We no
//   longer re-code that into a NOT_A_METHOD miss grammar — a wrong guess simply errors, same as
//   through the dotted door. A genuine app error from a live provider method propagates untouched.
test("a leaf miss through the EXPLICIT door also rejects", async () => {
  const { itx } = await slackRig(c("leaf"));
  const err = await rejectionOf(
    itx.invokeCapability(["itx", "slack", "chat", ["nosuchMethod", { channel: "#x", text: "y" }]]),
    15_000,
    "explicit-door call on a method the bridge never had",
  );
  expect(messageOf(err)).toBeTruthy();
});

// BUG (historical): awaiting a dangling dotted chain node rejected instead of settling to a
//   usable handle — there was nothing for the pull to resolve.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:108-114 "awaiting an instance must not
//   treat it as a thenable" + utils.ts:370-372 — `then` must stay absent so an await settles
//   instead of dispatching): `await itx.b9` yields a truthy handle and the chain stays
//   callable afterwards.
// ACTUAL: the await REJECTS with TypeError: Cannot read properties of undefined (reading
//   'get'). (The `then`-as-path-segment half is capnweb-native and fine — the rejection is the
//   missing surface, not a corrupted path.)
// WHY IT MATTERS: real client code parks chain nodes in variables, logs them, and awaits them
//   mid-chain (apps/os pinned this after `await stub` bugs turned every await into a dispatch);
//   a surface where mid-chain awaits throw forces callers into single-expression gymnastics.
// FIXED: the dotted fallback's path proxies keep `then` absent (RESERVED_DYNAMIC_PATH_SEGMENTS),
// so awaiting a dangling chain node settles to a usable handle instead of dispatching — and the
// chain stays callable afterwards (now spelled through the mount path, the live stub's identity).
test("an unawaited dotted chain is await-safe: awaiting mid-chain yields a live handle", async () => {
  const itx = await connectedRig(c("await"), "b9");
  const node = itx.b9; // unawaited dotted chain node — no call yet
  const handle: any = await node; // must settle (never treat `then` as a path segment)
  expect(handle).toBeTruthy();
  expect(await node.hello()).toBe("hello-from-b9"); // the chain stays callable after the await
});

// ADAPTED FROM apps/os/src/domains/itx/path-proxy.test.ts:108-114 (Promise.resolve(target)
// resolves to target — `then` reaching a dynamic surface would turn every await into a call
// that never resolves): the ROOT half of then-safety. Passes today — capnweb's settled stubs
// are not thenables — pinned so a future dotted fallback cannot regress it.
test("awaiting the root itx stub again neither hangs nor dispatches (then-safety)", async () => {
  const itx = await harness.itx(c("then"));
  const again: any = await Promise.resolve(itx); // a settled stub must not look thenable
  const who = await again.invokeCapability(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: c("then") });
});

// BUG: the stringify-safety halves hold today only VACUOUSLY — the chain is dead end to end,
//   so no probe can dispatch — and the liveness half fails outright.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:156-207, esp. 185-207 "probes are
//   blocked at DEPTH too"): JSON.stringify of a dangling chain node (a logged handle, a report
//   object) returns a string, fires NO live capability dispatch (toJSON/asymmetricMatch are
//   protocol probes, not path segments — PROTOCOL_PROBE_KEYS in apps/os utils.ts), and the
//   node remains a live handle afterwards.
// ACTUAL: JSON.stringify({ node }) is safe today ("{}", no dispatch, no unhandled rejection —
//   capnweb serves the probe from RpcPromise.prototype), but `await node.hello()` rejects with
//   TypeError: Cannot read properties of undefined (reading 'get') — there is no dotted
//   surface for the node to be a handle OF. When the fallback lands, the probe-blocking
//   contract must land WITH it or every stringify/assert of a handle becomes a live call.
// WHY IT MATTERS: apps/os learned this twice — a truthy-Promise `asymmetricMatch` made vitest
//   equalities SPURIOUSLY PASS, and stringify of a logged mount fired live invokes at depth ≥ 1
//   after the first hop-level fix.
// FIXED: stringify-safety holds (the hop's path proxies block toJSON — proven in
// core/dotted-path-proxy.test.ts) AND `node.hello()` answers — through the mount path, the live
// stub's one identity.
test("JSON.stringify of a dangling chain node must not dispatch, and the node stays live", async () => {
  const itx = await connectedRig(c("json"), "rec");
  const node = itx.rec; // a dangling dispatcher (a logged handle, a report object)
  const out = JSON.stringify({ node }); // probes toJSON — must NOT fire a live capability call
  expect(typeof out).toBe("string");
  expect(await node.hello()).toBe("hello-from-rec"); // still a live handle afterwards
});

// SUPERSEDED (pipelining todo): the e2e connect call-then-call rides a ONE-SHOT batch that cannot survive an extra round trip, and dispatch.test.ts's 'pipelined RPC promise threading' pins the walk contract.

// PINS core/dotted-path-proxy.ts's reserved-word promise AGAINST THE LIVE SURFACE (unit half:
// core/dotted-path-proxy.test.ts "hides reserved path segments from function-backed path
// proxies"). RESERVED_DYNAMIC_PATH_SEGMENTS hides JS/transport machinery ('then', 'dup',
// 'onRpcBroken', …) at the prototype hop AND inside every path proxy it hands out, so a
// protocol probe can never conjure a dispatcher. Observable stakes on the live itx: a probe
// that DID dispatch would commit through the capability table (an event, a tally tick) or
// resolve as a mount — so the pin is behavioral: probe everywhere, then prove the log and the
// tally never moved and every handle stayed live.
test("reserved segments are hidden at EVERY depth: transport words never dispatch as capability paths", async () => {
  const ctx = c("resv");
  const itx = await harness.itx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await itx.append({ type: "resv-mark", payload: {} }); // direct write — one durable row
  // Baseline: the durable head and tally's reduce of it (enable commits a subscription event too).
  const readHead = async (): Promise<number> => {
    const { events } = (await itx.invokeCapability(["itx", ["read", 0, 500]])) as {
      events: { offset: number }[];
    };
    return events.length ? events[events.length - 1].offset : 0;
  };
  const head = await readHead();
  const baseline: any = await until("tally reduced the baseline log", async () => {
    const s: any = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
    return s.offset >= head && s;
  });

  // (a) A dotted chain is AWAITABLE: `then` on the chain is capnweb's thenable hook, never a
  // path segment — were it a segment, the await would dispatch ['itx','whoami','then',…] and
  // reject at the table instead of settling with the real answer.
  const chain = itx.whoami(); // unawaited dotted call — an RpcPromise
  expect(typeof (chain as any).then).toBe("function"); // the hook, served by the promise itself
  expect(await chain).toMatchObject({ projectId: ctx, path: "/" });

  // (b) capnweb transport words at the ROOT resolve to TRANSPORT machinery: `dup()` hands back
  // a duplicate stub that still answers the real surface (a fallen-through probe would instead
  // dispatch ['itx',['dup']] and reject 'no capability matches'), and `onRpcBroken` registers a
  // callback without ever touching the wire as a path.
  expect(typeof (itx as any).dup).toBe("function");
  expect(typeof (itx as any).onRpcBroken).toBe("function");
  const dupped: any = (itx as any).dup();
  expect(await dupped.invokeCapability(["itx", ["whoami"]])).toMatchObject({ projectId: ctx });
  (itx as any).onRpcBroken(() => {}); // registers locally; must not travel as a path

  // (c) The SAME at depth 2, on an InvokeHandle: on the UNAWAITED chain node all three words are
  // the promise's own transport surface (functions, served locally — observed, not path
  // segments); on the SETTLED handle the hop's `then`-hiding makes the stub a NON-thenable
  // (`then` is undefined — a second await would settle, never dispatch) while dup/onRpcBroken
  // stay transport; and the handle stays live through every probe.
  const node = itx.facets.get("tally"); // unawaited dotted chain — no call yet
  expect(typeof (node as any).then).toBe("function");
  expect(typeof (node as any).dup).toBe("function");
  expect(typeof (node as any).onRpcBroken).toBe("function");
  const handle: any = await node; // settles (then-safety) — a stub of the InvokeHandle
  expect(handle.then).toBeUndefined(); // the hop hides `then`: settled stubs are not thenables
  expect(typeof handle.dup).toBe("function");
  expect(typeof handle.onRpcBroken).toBe("function");
  const snap: any = await handle.snapshot(); // the chain stays callable after every probe

  // NOTHING dispatched: no probe committed an event (head unmoved) and tally never ticked.
  expect(await readHead()).toBe(head);
  expect(snap.state.counts).toEqual(baseline.state.counts);
  expect(snap.state.counts["resv-mark"]).toBe(1);
});

// UNSPELLABLE (instance-fields todo): IterateContext keeps ALL state in #private fields by design — there is no own property for a dotted probe to shadow, so apps/os's /instance property/ guard has nothing to guard here.

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
// In THIS clean room the client is JUST capnweb (itx-surface.ts invariant) and the Itx
// RpcTarget answers only its fixed methods (invokeCapability / invoke / provide / …), so the
// natural dotted spelling is expected to be MISSING today. Every test below asserts the
// CORRECT (apps/os-proven) behavior, adapted to our built-ins (whoami / kv / stream /
// rpcStubs) and our live-bridge shape (proofs/prove_slack.mjs); genuinely-failing ones are
// `test.fails` with BUG/EXPECTED/ACTUAL/WHY blocks. Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-dotted-surface.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
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

/** ADAPTED from apps/os/src/itx/path-proxy.ts isPathMissMessage (verbatim semantics): a
 *  path-resolution miss must speak THIS grammar so error normalizers (slack-api.ts
 *  normalizeSlackError et al.) can answer with the surface's calling convention. */
const isPathMissMessage = (message: string): boolean =>
  message.includes("did not resolve to a function") ||
  /Capability path .* hit (undefined|null)\./.test(message) ||
  message.includes("Capability invoked as a function but the target is not callable");

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
 *  shape: provider session + consumer session over the same context). The bridge is a LIVE rpc
 *  stub under key 'slack', named at `itx.slack` by an ordinary by-value mount — so every other
 *  client just speaks `itx.slack.chat.postMessage(...)`. */
async function slackRig(ctx: string) {
  const sdkCalls: Array<[string, Record<string, unknown>]> = [];
  const bridgeItx = await harness.itx(ctx);
  await bridgeItx.rpcStubs.provide(new SlackReplayTarget(sdkCalls), { key: "slack" });
  await bridgeItx.provide({ path: "itx.slack", target: "itx.rpcStubs.get('slack')" });
  const itx = await harness.itx(ctx);
  // Sanity through the EXPLICIT door — the mount is live before any dotted attempt.
  await until("slack mount routable via the explicit door", async () => {
    const posted: any = await itx.invokeCapability({
      path: ["slack", "chat", "postMessage"],
      args: [{ channel: "#sanity", text: "rig up" }],
    });
    return posted?.ok === true;
  });
  sdkCalls.length = 0; // the sanity call is rig noise, not test data
  return { itx, sdkCalls };
}

/** Provide a Tools rpc stub under `key` and wait until it answers via the STRING door (the door
 *  that provably works today — reconnect-same-key.test.ts uses it throughout). */
async function connectedRig(ctx: string, key: string) {
  const itx = await harness.itx(ctx);
  const s = harness.session(ctx);
  await s.get().rpcStubs.provide(new Tools(key), { key });
  await until(`rpc stub '${key}' answers via the string door`, async () => {
    return (await itx.invoke(`itx.rpcStubs.get('${key}').hello()`)) === `hello-from-${key}`;
  });
  return itx;
}

// ── the explicit doors (the working baseline the dotted surface must sugar) ──

// ADAPTED FROM apps/os/src/domains/itx/path-proxy.test.ts:50-54 ("keeps real RpcTarget members
// …"): declared members must keep answering when a dotted fallback exists — pinned here first
// so every test.fails below is a missing-sugar bug, never a broken door.
test("explicit door: invokeCapability(['whoami']) answers (the half the dotted surface sugars)", async () => {
  const itx = await harness.itx(c("door"));
  const who = await itx.invokeCapability({ path: ["whoami"], args: [] });
  expect(who).toMatchObject({ projectId: c("door"), path: "/" });
});

// ADAPTED FROM proofs/prove_slack.mjs:84-98 + apps/os/src/domains/integrations/slack-api.test.ts:60-74
// (a WebClient-shaped call rides the project surface end to end): the deep live-bridge replay
// works TODAY through the explicit door — the dotted spelling below is pure client sugar.
test("explicit door: deep slack replay through a live bridge works today", async () => {
  const { itx, sdkCalls } = await slackRig(c("sdoor"));
  const posted: any = await itx.invokeCapability({
    path: ["slack", "chat", "postMessage"],
    args: [{ channel: "#general", text: "hello from itx" }],
  });
  expect(posted).toMatchObject({ ok: true, ts: "1755.000100", channel: "#general" });
  expect(sdkCalls).toEqual([["chat.postMessage", { channel: "#general", text: "hello from itx" }]]);
});

// ── the natural dotted surface (apps/os-proven; missing here) ──

// BUG: the Itx RpcTarget (src/core/itx-surface.ts) answers ONLY its fixed methods — there is no
//   prototype-hop / path-proxy fallback, so an unknown dotted root never becomes an
//   invokeCapability dispatch.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:50-61 "falls back only for unknown
//   paths"): `itx.whoami()` = sugar for invokeCapability({ path: ["whoami"], args: [] }) →
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

// BUG: same missing fallback, one level deeper — `kv` resolves to undefined ON the Itx
//   RpcTarget and the follow-path walk explodes on the next segment.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:55-56 — stub.nested.math.add /
//   stub.tools.greeter.sayHello accumulate path segments and dispatch once): itx.kv.put →
//   invokeCapability({ path: ["kv","put"], args: ["k","v"] }) → { ok: true }; itx.kv.get → "v".
//   The explicit door proves the capability itself works (DEFAULT_CONFIG_MOUNTS mounts itx.kv).
// ACTUAL: rejects with TypeError: Cannot read properties of undefined (reading 'put') — a raw
//   JS property miss on the server, uncoded ({ remote: true } only).
// WHY IT MATTERS: depth-2 built-ins (kv, stream, secrets) are the bread-and-butter calls; the
//   error also violates core/errors.ts (nothing machine-readable rides it).
test("depth-2 dotted: itx.kv.put('k','v') then itx.kv.get('k') round trips", async () => {
  const itx = await harness.itx(c("kv"));
  expect(await itx.kv.put("k", "v")).toMatchObject({ ok: true });
  expect(await itx.kv.get("k")).toBe("v");
});

// BUG: the dotted spelling of the commonest write in the platform does not exist.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:50-61 — declared members and dynamic
//   paths are ONE coexisting surface): `itx.stream.append({...})` commits through the same log
//   the explicit door reads back — dotted write, explicit read, one surface.
// ACTUAL: rejects with TypeError: Cannot read properties of undefined (reading 'append').
// WHY IT MATTERS: built-ins.ts's own comment sells `stream` as "the commonest write is
//   dotted-door spellable" — true only from inside loaded workers (itx.js), false for the
//   capnweb client the platform tells everyone is the whole SDK.
test("dotted write, explicit read: itx.stream.append lands in the ONE log", async () => {
  const itx = await harness.itx(c("stream"));
  const [committed] = await itx.stream.append({ type: "mark", payload: { n: 1 } });
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page: any = await itx.invokeCapability({ path: ["stream", "read"], args: [] });
  expect(page.events.some((e: any) => e.type === "mark")).toBe(true);
});

// FIXED: `itx.rpcStubs.get('b')` returns a genuine, pipelinable RpcTarget (core/invoke-handle.ts —
//   `InvokeHandle`, prototype-hop installed, dispatch → #rpcStubs.invoke(key,path,args)) instead of a
//   bare `pathProxy`. workerd's pipeline classifier accepts a real RpcTarget on both lanes (capnweb's
//   RpcTarget IS the native cloudflare:workers RpcTarget), so capnweb pipelines `.hello()` across the
//   /api→DO boundary to the client relay (2 hops). The fold is identical (`.hello()` → invoke(key,
//   ['hello'], [])); the only change is the pipelinable brand. Was: `TypeError: The RPC receiver does
//   not implement the method "hello"` (a Proxy is NonPipelinable; cloudflare/workerd#6873).
test("mid-chain call: itx.rpcStubs.get('b').hello() answers from a live rpc stub", async () => {
  const itx = await connectedRig(c("conn"), "b");
  expect(await itx.rpcStubs.get("b").hello()).toBe("hello-from-b");
});

// BUG: the flagship use case — a WebClient-shaped SDK behind a live bridge — has no dotted
//   client spelling; only the explicit door works (proven by the plain test above).
// EXPECTED (apps/os/src/domains/integrations/slack-api.test.ts:60-74 — the itx caller surface
//   IS `…chat.postMessage({...})`; proofs/prove_slack.mjs:84-98 — same call via the explicit
//   door): `itx.slack.chat.postMessage({...})` → { ok: true, … } and the bridge-side SDK
//   receives the exact call.
// ACTUAL: rejects with TypeError: Cannot read properties of undefined (reading 'chat') — the
//   walk dies on `slack` being undefined on the Itx RpcTarget; the bridge never hears anything.
// WHY IT MATTERS: "every other client of the project then just speaks
//   itx.slack.chat.postMessage(...)" is prove_slack.mjs's OWN promise (line 5) — today that
//   sentence is only true for callers willing to hand-build { path, args }.
test("slack-style deep SDK replay: itx.slack.chat.postMessage({...})", async () => {
  const { itx, sdkCalls } = await slackRig(c("slack"));
  const posted: any = await itx.slack.chat.postMessage({ channel: "#dotted", text: "sugar" });
  expect(posted).toMatchObject({ ok: true, channel: "#dotted" });
  expect(sdkCalls).toEqual([["chat.postMessage", { channel: "#dotted", text: "sugar" }]]);
});

// FIXED: a wrong guess at a dotted surface (`itx.slack.api.postMessage` — the invented `.api.`
//   namespace from slack-api.test.ts's own fixture) now rejects in the platform's ONE miss grammar,
//   naming the FULL attempted dotted path. The dotted path REACHES the capability table (the hop
//   landed), dispatches invokeCapability({path:["slack","api","postMessage"]}), routes through the
//   parked-connection relay, and the remote SlackReplayTarget's absent `.api` surfaces as a raw JS
//   TypeError inside RetainedCallbackInvoker.invoke (core/itx-surface.ts). That catch now re-codes a
//   provider-side path MISS (isProviderPathMiss: "… is not a function." / "Cannot read properties of
//   undefined|null (reading …)") into "Capability path api.postMessage did not resolve to a function."
//   (code NOT_A_METHOD), so isPathMissMessage(msg) matches. A genuine app error propagates untouched.
// WHY IT MATTERS: the miss message is the surface's error-repair loop — apps/os's
//   normalizeSlackError turns exactly this grammar into "here is the call grammar; use
//   itx.integrations.list()"; without it a caller (human or agent) gets a raw error.
test("a dotted mid-path miss NAMES the full attempted path in the miss grammar", async () => {
  const { itx } = await slackRig(c("miss"));
  const err = await rejectionOf(
    itx.slack.api.postMessage({ channel: "#x", text: "y" }),
    15_000,
    "dotted call through an invented namespace",
  );
  const msg = messageOf(err);
  expect(msg).toContain("api.postMessage"); // the FULL attempted path, dotted
  expect(isPathMissMessage(msg)).toBe(true); // the recognizable miss grammar
});

// FIXED: even through the WORKING explicit door, a leaf miss on a live bridge now speaks the
//   platform's miss grammar — full attempted path AND isPathMissMessage-recognizable wording.
//   invokeCapability({path:["slack","chat","nosuchMethod"]}) routes through the parked-connection
//   relay; the remote SlackReplayTarget's `chat` exists but `.nosuchMethod` does not, so capnweb
//   rejects with TypeError: 'chat.nosuchMethod' is not a function. inside RetainedCallbackInvoker.invoke
//   (core/itx-surface.ts). That catch now re-codes the provider-side path MISS (isProviderPathMiss)
//   into "Capability path chat.nosuchMethod did not resolve to a function." (code NOT_A_METHOD), so
//   isPathMissMessage(msg) matches and the full dotted path is named — no message-sniffing of capnweb
//   internals required. A genuine app error from a live provider method propagates untouched.
// WHY IT MATTERS: our replay pipeline (capability-table walkSteps → RetainedCallbackInvoker →
//   provider-side capnweb) had three different miss vocabularies depending on WHERE the walk
//   dies; apps/os proved one shared grammar (isPathMissMessage) is what makes misses repairable.
test("a leaf miss through the EXPLICIT door keeps the same miss grammar", async () => {
  const { itx } = await slackRig(c("leaf"));
  const err = await rejectionOf(
    itx.invokeCapability({
      path: ["slack", "chat", "nosuchMethod"],
      args: [{ channel: "#x", text: "y" }],
    }),
    15_000,
    "explicit-door call on a method the bridge never had",
  );
  const msg = messageOf(err);
  expect(msg).toContain("chat.nosuchMethod"); // the FULL attempted path, dotted
  expect(isPathMissMessage(msg)).toBe(true); // the recognizable miss grammar
});

// BUG: awaiting a dangling dotted chain node rejects instead of settling to a usable handle —
//   there is nothing at `rpcStubs` for the pull to resolve.
// EXPECTED (apps/os/src/domains/itx/path-proxy.test.ts:108-114 "awaiting an instance must not
//   treat it as a thenable" + utils.ts:370-372 — `then` must stay absent so an await settles
//   instead of dispatching): `await itx.rpcStubs.get('b9')` yields a truthy handle and the
//   chain stays callable afterwards.
// ACTUAL: the await REJECTS with TypeError: Cannot read properties of undefined (reading
//   'get'). (The `then`-as-path-segment half is capnweb-native and fine — the rejection is the
//   missing surface, not a corrupted path.)
// WHY IT MATTERS: real client code parks chain nodes in variables, logs them, and awaits them
//   mid-chain (apps/os pinned this after `await stub` bugs turned every await into a dispatch);
//   a surface where mid-chain awaits throw forces callers into single-expression gymnastics.
// FIXED: the rpc-stub handle is now a pipelinable `InvokeHandle` (RpcTarget), so `node.hello()`
// answers after the await. The await-safety half (`then` stays absent → await settles to the
// handle, never dispatches) holds via the RpcTarget prototype hop.
test("an unawaited dotted chain is await-safe: awaiting mid-chain yields a live handle", async () => {
  const itx = await connectedRig(c("await"), "b9");
  const node = itx.rpcStubs.get("b9"); // unawaited dotted chain — no call yet
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
  const who = await again.invokeCapability({ path: ["whoami"], args: [] });
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
// core/dotted-path-proxy.test.ts) AND `node.hello()` answers — the rpc-stub handle is now a
// pipelinable `InvokeHandle` (RpcTarget).
test("JSON.stringify of a dangling chain node must not dispatch, and the node stays live", async () => {
  const itx = await connectedRig(c("json"), "rec");
  const node = itx.rpcStubs.get("rec"); // a dangling dispatcher (a logged handle, a report object)
  const out = JSON.stringify({ node }); // probes toJSON — must NOT fire a live capability call
  expect(typeof out).toBe("string");
  expect(await node.hello()).toBe("hello-from-rec"); // still a live handle afterwards
});

// ── unadaptable here (named apps/os sources) ──

test.todo(
  "pipelining: one round trip for a whole dotted chain (apps/os e2e/vitest/agent-handle-pipelining.itx.e2e.test.ts) — frame-level pinning belongs to the sibling wire agent",
);
test.todo(
  "reserved segments are hidden at EVERY depth (proxy.then / proxy.alpha.then / dup / onRpcBroken yield undefined, never path segments) — apps/os/src/domains/itx/path-proxy.test.ts:267-279 + apps/os/src/itx/path-proxy.ts:39-63 — unspellable until any dotted surface exists to hide them from",
);
test.todo(
  "instance fields never become dynamic paths (stub.ownField() rejects with /instance property/) — apps/os/src/domains/itx/path-proxy.test.ts:116-120 — our Itx keeps all state in #private fields, so there is no field to probe until a dotted fallback exists",
);

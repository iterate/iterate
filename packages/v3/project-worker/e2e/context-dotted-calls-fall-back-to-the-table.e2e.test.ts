// context-dotted-calls-fall-back-to-the-table.e2e.test.ts — the NATURAL DOTTED CLIENT SURFACE. A
// client speaks deep dotted itx expressions as PLAIN PROPERTY ACCESS on the capnweb stub —
// `itx.slack.chat.postMessage({...})`, `itx.kv.put('k','v')` — even though only fixed members are
// real methods anywhere along the path: the prototype hop (context/dotted-path-proxy.ts) turns every
// unknown segment into ONE accumulated `invoke(expression)` dispatch. Proves the root and depth-2
// built-ins, a lent rpc stub through its rewrite rule's match, that a wrong guess REJECTS (raw — the
// NOT_A_METHOD re-grammar was removed, an apps/os error-normalizer nicety with no clean-room
// consumer), then-safety (an await settles instead of dispatching), stringify-safety, and that the
// reserved transport words (then/dup/onRpcBroken) never dispatch as itx expressions at ANY depth.

import { expect, test } from "vitest";
import { freshCtx, openItx, readHead, rejection, until } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";
import { SlackReplayTarget, Tools } from "./support/targets.ts";

/** Attach a slack bridge to `ctx` and hand back an ordinary second client: provider session +
 *  consumer session over the same context. The bridge is a LIVE rpc stub lent under the key
 *  `itx.slack` with the rewrite rule `itx.slack ⇒ itx.rpcStubs.get('itx.slack')` — so every other
 *  client just speaks `itx.slack.chat.…`. */
async function slackRig(ctx: string) {
  const slack = new SlackReplayTarget();
  await openItx(ctx).provide("itx.slack", slack);
  const itx = openItx(ctx);
  // Sanity through the EXPLICIT door — the rule rewrites before any dotted attempt.
  await until("slack rule rewrites via the explicit door", async () => {
    const posted: any = await itx.invoke([
      "itx",
      "slack",
      "chat",
      ["postMessage", { channel: "#sanity", text: "rig up" }],
    ]);
    return posted?.ok === true;
  });
  slack.calls.length = 0; // the sanity call is rig noise, not test data
  return { itx, slack };
}

/** Lend a live Tools stub behind the rule `itx.<name>` and wait until it answers via the STRING door. */
async function liveRig(ctx: string, name: string) {
  const itx = openItx(ctx);
  await openItx(ctx).provide(`itx.${name}`, new Tools(name));
  await until(`lent stub 'itx.${name}' answers via the string door`, async () => {
    return (await itx.invoke(`itx.${name}.hello()`)) === `hello-from-${name}`;
  });
  return itx;
}

test("explicit door: invoke(['itx', ['whoami']]) answers (the half the dotted surface sugars)", async () => {
  const ctx = freshCtx("door");
  const who = await openItx(ctx).invoke(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: ctx, path: "/" });
});

test("root dotted call: await itx.whoami() falls back to the ONE invoke door", async () => {
  const ctx = freshCtx("who");
  const who = await openItx(ctx).whoami();
  expect(who).toMatchObject({ projectId: ctx, path: "/" });
});

test("depth-2 dotted: itx.kv.put('k','v') then itx.kv.get('k') round trips", async () => {
  const itx = openItx(freshCtx("kv"));
  expect(await itx.kv.put("k", "v")).toMatchObject({ ok: true });
  expect(await itx.kv.get("k")).toBe("v");
});

test("dotted write, expression read: itx.append lands in the ONE log", async () => {
  // `itx.append(...)` is the dotted hop onto the built-in `append` ROOT (IterateContext declares no
  // such method); the read is the same root reached as an EXPRESSION. One log serves both spellings.
  const itx = openItx(freshCtx("stream"));
  const [committed] = await itx.append({ type: "mark", payload: { n: 1 } });
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page: any = await itx.invoke(["itx", ["read"]]);
  expect(page.events.some((e: any) => e.type === "mark")).toBe(true);
});

test("dotted call through a rewrite rule's match: itx.b.hello() answers from a lent rpc stub", async () => {
  // The rule is pure data whose TARGET names the physical registry (`itx.rpcStubs.get('itx.b')`);
  // the resolver evaluates that target against the built-in and its RpcStubHandle pipelines the
  // `.hello()` remainder into one DO-side dispatch.
  const itx = await liveRig(freshCtx("conn"), "b");
  expect(await itx.b.hello()).toBe("hello-from-b");
});

test("a dotted mid-path miss REJECTS (the invented namespace resolves to nothing callable)", async () => {
  // A wrong guess at a live provider's surface propagates the RAW capnweb reject — it still ERRORS
  // (that's the contract), just without a re-grammared "did not resolve to a function".
  const { itx } = await slackRig(freshCtx("miss"));
  const err = await rejection(
    itx.slack.api.postMessage({ channel: "#x", text: "y" }),
    "dotted call through an invented namespace",
  );
  expect(String(err.message ?? err)).toBeTruthy();
});

test("a leaf miss through the EXPLICIT door also rejects", async () => {
  const { itx } = await slackRig(freshCtx("leaf"));
  const err = await rejection(
    itx.invoke(["itx", "slack", "chat", ["nosuchMethod", { channel: "#x", text: "y" }]]),
    "explicit-door call on a method the bridge never had",
  );
  expect(String(err.message ?? err)).toBeTruthy();
});

test("an unawaited dotted chain is await-safe: awaiting mid-chain yields a live handle", async () => {
  // The dotted fallback's path proxies keep `then` absent (RESERVED), so
  // awaiting a dangling chain node settles to a usable handle instead of dispatching — and the chain
  // stays callable afterwards (real client code holds chain nodes in variables and awaits them).
  const itx = await liveRig(freshCtx("await"), "b9");
  const node = itx.b9; // unawaited dotted chain node — no call yet
  const handle: any = await node; // must settle (never treat `then` as a path segment)
  expect(handle).toBeTruthy();
  expect(await node.hello()).toBe("hello-from-b9"); // the chain stays callable after the await
});

test("awaiting the root itx stub again neither hangs nor dispatches (then-safety)", async () => {
  // The ROOT half of then-safety: capnweb's settled stubs are not thenables — pinned so a future
  // dotted fallback cannot regress it.
  const ctx = freshCtx("then");
  const itx = await openItx(ctx);
  const again: any = await Promise.resolve(itx); // a settled stub must not look thenable
  const who = await again.invoke(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: ctx });
});

test("JSON.stringify of a dangling chain node must not dispatch, and the node stays live", async () => {
  // toJSON/asymmetricMatch are protocol probes, not path segments: stringify of a logged handle
  // returns a string, fires NO dispatch to the lent stub, and the node remains a live handle.
  const itx = await liveRig(freshCtx("json"), "rec");
  const node = itx.rec; // a dangling dispatcher (a logged handle, a report object)
  const out = JSON.stringify({ node }); // probes toJSON — must NOT fire a call on the lent stub
  expect(typeof out).toBe("string");
  expect(await node.hello()).toBe("hello-from-rec"); // still a live handle afterwards
});

// PINS context/dotted-path-proxy.ts's reserved-word promise AGAINST THE LIVE SURFACE (unit half:
// dotted-path-proxy.test.ts "hides reserved path segments from function-backed path proxies").
// RESERVED hides JS/transport machinery ('then', 'dup', 'onRpcBroken', …) at
// the prototype hop AND inside every path proxy it hands out, so a protocol probe can never conjure
// a dispatcher. Observable stakes on the live itx: a probe that DID dispatch would commit through
// the dispatch door (an event, a tally tick) or be refused by the rewrite rules — so the pin is
// behavioral: probe everywhere, then prove the log and the tally never moved and every handle stayed live.
test("reserved segments are hidden at EVERY depth: transport words never dispatch as itx expressions", async () => {
  const ctx = freshCtx("resv");
  const itx = await openItx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await itx.append({ type: "resv-mark", payload: {} }); // direct write — one durable row
  // Baseline: the durable head and tally's reduce of it (enable commits a subscription event too).
  const head = await readHead(itx);
  const baseline: any = await until("tally reduced the baseline log", async () => {
    const s: any = await itx.invoke("itx.facets.get('tally').snapshot()");
    return s.offset >= head && s;
  });

  // (a) A dotted chain is AWAITABLE: `then` on the chain is capnweb's thenable hook, never a
  // path segment — were it a segment, the await would dispatch ['itx','whoami','then',…] and
  // reject at the rewrite rules instead of settling with the real answer.
  const chain = itx.whoami(); // unawaited dotted call — an RpcPromise
  expect(typeof (chain as any).then).toBe("function"); // the hook, served by the promise itself
  expect(await chain).toMatchObject({ projectId: ctx, path: "/" });

  // (b) capnweb transport words at the ROOT resolve to TRANSPORT machinery: `dup()` hands back
  // a duplicate stub that still answers the real surface (a fallen-through probe would instead
  // dispatch ['itx',['dup']] and reject 'no rewrite rule matches'), and `onRpcBroken` registers a
  // callback without ever touching the wire as a path.
  expect(typeof (itx as any).dup).toBe("function");
  expect(typeof (itx as any).onRpcBroken).toBe("function");
  const dupped: any = (itx as any).dup();
  expect(await dupped.invoke(["itx", ["whoami"]])).toMatchObject({ projectId: ctx });
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
  expect(await readHead(itx)).toBe(head);
  expect(snap.state.counts).toEqual(baseline.state.counts);
  expect(snap.state.counts["resv-mark"]).toBe(1);
});

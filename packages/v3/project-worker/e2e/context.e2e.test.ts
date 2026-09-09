// context.e2e.test.ts — the CONTEXT across the /api hop: its built-in roots, the error grammar, and the
// natural dotted client surface — deep dotted itx expressions as PLAIN PROPERTY ACCESS on the capnweb
// stub (`itx.slack.chat.postMessage({...})`, `itx.kv.put('k','v')`): only fixed members are real
// methods along the path; the prototype hop (context/expression.ts) turns every unknown segment into
// ONE accumulated `invoke(expression)` dispatch. Pins:
//   • a ':' in the ctx at the /expression door is a 400 naming the wall — the edge parses the context
//     name before it names a DO (the codec's charset gate itself: context/durable-object-names.test.ts)
//   • `kv.list` returns EVERY key, not the first KV page
//   • `cd('')` is SELF — an in-process call on this very context, never a self-RPC hop or a twin DO
//   • a default-deny miss and a paused-stream refusal each carry their machine-readable `code` end to
//     end (lib.ts: classify by code, never by message — own props survive DO → relay → client)
//   • the explicit door `invoke(['itx', ['whoami']])`, the root dotted call, depth-2 built-ins, a dotted
//     write beside an expression read (ONE log), a lent rpc stub through its rule's match
//   • a wrong guess REJECTS raw (no NOT_A_METHOD re-grammar), through the dotted and the explicit door
//   • then-safety (an awaited chain node settles into a live handle; a settled stub is not a thenable),
//     stringify-safety (toJSON never dispatches), and the reserved transport words (then / dup /
//     onRpcBroken) hidden at EVERY depth — pinned behaviorally: the log and a tally never move

import { expect, test } from "vitest";
import {
  append,
  codeOf,
  expressionUrl,
  freshCtx,
  openItx,
  readHead,
  rejection,
  until,
} from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";
import { SlackReplayTarget, Tools } from "./support/targets.ts";

// ── the built-in roots and the error grammar ──

test("a ':' in the ctx at the /expression door is a 400 naming the wall — the edge parses the context name before it names a DO", async () => {
  // DurableObjectNameCodec.parse gates the projectId to [A-Za-z0-9_-] (the ONE place every DO name is
  // parsed; context/durable-object-names.test.ts pins the gate). The edge runs it on `?context=`
  // before any object is addressed, so a ":"-nested project — whose prefixed kv key would alias
  // another project's — is refused at the door and never materialized; the prefix IS the isolation wall.
  const viaDoor = await fetch(expressionUrl("prj_x:evil", "itx.whoami"));
  expect(viaDoor.status).toBe(400);
  expect(await viaDoor.text()).toContain("invalid projectId");
});

test("kv list returns EVERY key, not silently the first 1000", async () => {
  // Cloudflare KV caps a list page at 1000 keys; `kv.list()` paginates on the cursor until
  // `list_complete`, so key 1001+ is never a permanent orphan for a sweep/GC/inventory caller.
  const itx = openItx(freshCtx("kvlist"));
  const total = 1001;
  const names = Array.from({ length: total }, (_, i) => `k${String(i).padStart(4, "0")}`);
  for (let i = 0; i < names.length; i += 100) {
    await Promise.all(names.slice(i, i + 100).map((n) => itx.kv.put(n, "1")));
  }
  const listed = await itx.invoke(["itx", "kv", ["list"]]);
  expect(listed.keys).toHaveLength(total);
}, 60_000);

test("cd('') resolves to THIS context (self) and answers rather than wedging", async () => {
  // `resolveContextPath("/", "")` is "/" — the root's own path — and the DO's `context(p)` hands
  // back ITSELF for its own path (iterate-context-durable-object.ts), so the empty spelling is an
  // in-process call on this very context, landing in the SAME log. Pinned with a deadline so a
  // regression to a self-RPC hop (or a twin DO) shows as a wedge or a split log, never as a 60 s
  // test timeout.
  const itx = openItx(freshCtx("self"));
  const raced = await Promise.race([
    itx.invoke("itx.cd('').append({type:'self-ping'})"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("self-context call wedged >10s (self-RPC deadlock)")),
        10_000,
      ),
    ),
  ]);
  expect((raced as any[])[0].type).toBe("self-ping");
  const page = await itx.invoke(["itx", ["readEvents", 0, 50]]);
  expect(page.events.map((e: any) => e.type)).toContain("self-ping");
});

test("a default-deny miss carries code NO_ITX_EXPRESSION_MATCH across the /api hop", async () => {
  const itx = openItx(freshCtx("codemiss"));
  const err = await rejection(itx.invoke(["itx", "nope", ["thing"]]));
  expect(codeOf(err)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(err.message).toMatch(/no rewrite rule matches/);
});

test("a paused-stream refusal carries code STREAM_PAUSED across the /api hop", async () => {
  // enforcement refusals ride the same coded channel end to end
  const itx = openItx(freshCtx("codepause"));
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "operator" } });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(codeOf(err)).toBe("STREAM_PAUSED");
  expect(err.message).toContain("stream paused");
});

// ── the natural dotted client surface ──

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
  const page: any = await itx.invoke(["itx", ["readEvents"]]);
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

// PINS context/expression.ts's reserved-word promise AGAINST THE LIVE SURFACE (unit half:
// expression.test.ts "hides reserved path segments from function-backed path proxies").
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

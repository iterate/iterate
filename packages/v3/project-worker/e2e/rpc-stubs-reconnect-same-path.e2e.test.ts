// rpc-stubs-reconnect-same-path.e2e.test.ts — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY, live.
//
// An rpc-stub PROVIDER is ephemeral: its capnweb WebSocket terminates at a STATELESS `/api` worker,
// and Cloudflare documents that a plain worker cannot durably hold a WebSocket (the isolate can be
// recycled, taking the socket + the in-memory callback it holds with it — capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So a provider dropping is EXPECTED;
// the platform's answer is RECONNECT at the same spelling, not server durability.
//
// This proves it against the real deployment: a provider goes OFFLINE (its session is disposed → the
// WS closes → the DO drops the stub from the `itx.rpcStubs` registry, and capnweb disposes the
// provided handle, which UN-SETS the rewrite rule `itx.p ⇒ itx.rpcStubs.get('itx.p')`) and
// re-provides at the SAME key — which re-lends under the same registry key and appends ONE more
// rewrite-rule-configured event (the map holds one rule again). The stub is callable AGAIN through
// the same dotted spelling. In between, the match answers NO_ITX_EXPRESSION_MATCH — a dead session
// leaves no offline row behind. This is the property the live hibernation proofs tried to force by
// waiting on Cloudflare — proven here deterministically by controlling the disconnect.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import {
  codeOf,
  openItx,
  freshCtx,
  presence,
  rpcStubRewriteRuleMatches,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";

// Disposing our own provider session mid-test surfaces the capnweb peer-close as an unhandled
// rejection — the deliberate disconnect, not a failure. The e2e config's onUnhandledError filter
// absorbs exactly that transport noise (e2e/vitest.config.ts); everything else stays fatal.

class Tools extends RpcTarget {
  #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  echo(s: string): string {
    return `echo-${this.#tag}:${s}`;
  }
}

const RULE_CONFIGURED = "events.iterate.com/itx/rewrite-rule-configured";
/** The durable log's rewrite-rule events at `itx.p`, as their targets — the reconnect adds ONE. */
const ruleTargetsAtP = (page: {
  events: { type: string; payload?: { match?: string; target?: string | null } }[];
}) =>
  page.events
    .filter((e) => e.type === RULE_CONFIGURED && e.payload?.match === "itx.p")
    .map((e) => e.payload?.target ?? null);

test("a provider drops and re-provides at the same key — default-deny in between (the rule died with the session), callable again, ONE rule event", async () => {
  // the consumer stays connected throughout and addresses the provider BY SPELLING (the rewrite
  // match IS the rpc-stub key the stub is lent under). Every session in this test shares ONE ctx
  // (one project DO).
  const ctx = freshCtx("recon");
  const itx = openItx(ctx);
  const ruleAtP = async (): Promise<unknown> =>
    (await itx.invoke("itx.facets.get('core').snapshot()")).state.itxExpressionRewriteRules[
      "itx.p"
    ];

  // 1. provider provides a live stub under itx.p with the rule itx.p ⇒ itx.rpcStubs.get('itx.p') →
  //    callable through the spelling.
  let providerSession = session();
  await providerSession.authenticate().projects.get(ctx).provide("itx.p", new Tools("v1"));
  const online = await until("callable online", async () =>
    (await itx.invoke("itx.p.echo('a')")) === "echo-v1:a" ? true : undefined,
  );
  expect(online).toBe(true); // 1. provider online: itx.p.echo() answers
  expect(await ruleAtP()).toEqual({
    match: ["itx", "p"],
    target: ["itx", "rpcStubs", ["get", "itx.p"]],
  });

  // 2. provider goes OFFLINE — dispose its session (WS closes → the DO drops the itx.p transport;
  //    capnweb disposes the handle → the rule is UN-SET). The match answers NO_ITX_EXPRESSION_MATCH
  //    — default-deny: no rule lingers pointing at a dead key.
  (providerSession as Partial<Disposable>)[Symbol.dispose]?.();
  const offline = await until("provider offline and its rule gone", async () => {
    try {
      await itx.invoke("itx.p.echo('b')");
      return undefined; // still answering — keep polling
    } catch (e) {
      return codeOf(e) === "NO_ITX_EXPRESSION_MATCH" ? (e as { code?: string }) : undefined;
    }
  });
  expect(codeOf(offline)).toBe("NO_ITX_EXPRESSION_MATCH"); // 2. default-deny, not a lingering offline rule
  expect(await ruleAtP()).toBeUndefined(); // the rule went with the session
  await until("the stub gone from presence", async () => !(await presence(itx)).includes("itx.p"));
  const logBefore = await itx.invoke("itx.read(0, 500)");
  expect(ruleTargetsAtP(logBefore)).toEqual(["itx.rpcStubs.get('itx.p')", null]); // set, then un-set

  // 3. provider RE-PROVIDES at the SAME key with a fresh instance — this re-lends under the same
  //    registry key and appends ONE more rule event (no dedupe; the map holds one rule again).
  providerSession = session();
  await providerSession.authenticate().projects.get(ctx).provide("itx.p", new Tools("v2"));

  // 4. THE CONTRACT: the stub is callable AGAIN through the same spelling — it resolves to the
  //    reconnected provider (v2), with no re-addressing by the caller.
  const after = await until("callable after reconnect", async () => {
    const r = await itx.invoke("itx.p.echo('c')");
    return r === "echo-v2:c" ? r : undefined;
  });
  expect(after).toBe("echo-v2:c"); // 3. reconnect at the SAME key: callable again

  // 5. RECONNECT APPENDS EXACTLY ONE EVENT — the rule's re-set — and the map holds one rule at itx.p.
  const logAfter = await itx.invoke("itx.read(0, 500)");
  expect(ruleTargetsAtP(logAfter)).toEqual([
    "itx.rpcStubs.get('itx.p')",
    null,
    "itx.rpcStubs.get('itx.p')",
  ]);
  expect(logAfter.events.length).toBe(logBefore.events.length + 1);
  expect(await ruleAtP()).toEqual({
    match: ["itx", "p"],
    target: ["itx", "rpcStubs", ["get", "itx.p"]],
  });
  expect((await rpcStubRewriteRuleMatches(itx)).filter((m) => m === "itx.p")).toEqual(["itx.p"]);
});

// The same property one layer up (was resub-zombie.e2e): a LIVE SUBSCRIBER is a stub lent under
// `subscription:<name>` plus one subscription row naming it. Re-subscribing the same name
// re-lends under the same key — the session disposes the first relay (its transport is REPLACED, the
// first callback physically unreachable) — and appends ONE more subscription-configured (same name
// REPLACES the row; there is no shadow stack and no dedupe). `subscribe({ name, target: null })`
// drops the one row and recalls this session's stub: no callback under that name receives anything
// afterwards.
test("a live subscriber re-subscribes under the same name — the transport is replaced (one row, one more event); a null target stops delivery for good", async () => {
  const itx = openItx(freshCtx("resub"));
  await itx.append({ type: "seed" });
  const rowsNamed = async (name: string): Promise<unknown[]> =>
    (await subscriptions(itx)).filter((r: { name: string }) => r.name === name);

  // ── CONTROL: a single live subscribe delivers; subscribe({ name, target: null }) stops it ──
  let ctrl = 0;
  await itx.subscribe({
    name: "control",
    consumes: ["ctl"],
    target: (events: unknown[]) => {
      ctrl += events.length;
    },
  });
  await itx.append({ type: "ctl", payload: { n: 1 } });
  await until("control delivered", () => ctrl === 1);
  await itx.subscribe({ name: "control", target: null });
  expect(await rowsNamed("control")).toHaveLength(0);
  await itx.append({ type: "ctl", payload: { n: 2 } });
  await sleep(1500);
  expect(ctrl).toBe(1); // NO delivery after the removal

  // ── re-subscribe the SAME name with a second callback ──
  let cb1 = 0;
  let cb2 = 0;
  await itx.subscribe({
    name: "s",
    consumes: ["mark"],
    target: (events: unknown[]) => {
      cb1 += events.length;
    },
  });
  const logBefore = await itx.read(0, 500);
  await itx.subscribe({
    name: "s", // the client's model: this REPLACES cb1
    consumes: ["mark"],
    target: (events: unknown[]) => {
      cb2 += events.length;
    },
  });
  // the replacing row appended ONE event, the table holds ONE row named s, and the key is present
  const logAfter = await itx.read(0, 500);
  expect(logAfter.events.length).toBe(logBefore.events.length + 1);
  expect(await rowsNamed("s")).toHaveLength(1);
  expect(await presence(itx)).toContain("subscription:s");

  await itx.append({ type: "mark", payload: { n: 1 } });
  await until("cb2 delivered", () => cb2 === 1);
  await sleep(1000);
  expect(cb1).toBe(0); // only the newest callback is reachable — cb1's transport was replaced

  // ── null target once: the row and this session's stub are gone; nobody under s hears the next mark ──
  await itx.subscribe({ name: "s", target: null });
  expect(await rowsNamed("s")).toHaveLength(0);
  await until("stub closed", async () => !(await presence(itx)).includes("subscription:s"));
  await itx.append({ type: "mark", payload: { n: 2 } });
  await sleep(1500);
  expect(cb1).toBe(0);
  expect(cb2).toBe(1);
});

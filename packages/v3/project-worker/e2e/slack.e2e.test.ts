// slack.e2e.test.ts — THE SLACK SDK USE CASE: `itx.slack` is a LIVE provided capability. A local
// node script (this file — in production a tiny bridge daemon) connects to /api over capnweb
// and provides an RpcTarget that REPLAYS dotted calls onto a Slack WebClient-shaped SDK
// instance (faked here with the exact call surface; swap in `new WebClient(token)` for real).
// Every other client of the project then just speaks `itx.slack.chat.postMessage(...)` and the
// call rides: capnweb → relay → stream DO table → hibernatable RPC stub (page → invoke) → this
// script → the SDK. Revoking the provision (or the bridge dying) takes the mount with it.
// (was proofs/prove_slack.mjs)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";

// ── the "real" SDK instance (WebClient shape; records what it was asked to do) ──
const sdkCalls: [string, Record<string, unknown>][] = [];
const slackSdk = {
  chat: {
    postMessage: async (opts: Record<string, unknown>) => {
      sdkCalls.push(["chat.postMessage", opts]);
      return { ok: true, ts: "1755.000100", channel: opts.channel };
    },
  },
  conversations: {
    list: async (opts?: Record<string, unknown>) => {
      sdkCalls.push(["conversations.list", opts ?? {}]);
      return {
        ok: true,
        channels: [
          { id: "C1", name: "general" },
          { id: "C2", name: "random" },
        ],
      };
    },
  },
};

/** The replay target: dotted itx.slack.* paths land here and replay onto the SDK verbatim. */
class SlackReplayTarget extends RpcTarget {
  get chat() {
    return { postMessage: (opts: Record<string, unknown>) => slackSdk.chat.postMessage(opts) };
  }
  get conversations() {
    return { list: (opts?: Record<string, unknown>) => slackSdk.conversations.list(opts) };
  }
}

/** THE ZERO-DECLARATION SHAPE (the apps/os replayPathCall idea, pushed to the client): a Proxy
 *  over a bare RpcTarget forwards every unknown property straight to the LITERAL SDK instance —
 *  no per-method table, no getters; `new WebClient(token)` drops in as `sdk` unchanged. (capnweb
 *  only passes RpcTargets/functions by reference, so the bare-RpcTarget core is what crosses;
 *  the Proxy fills its property surface from the SDK.) */
const replayOnto = (sdk: Record<PropertyKey, unknown>) =>
  new Proxy(new (class extends RpcTarget {})(), {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : sdk[prop]),
    has: (target, prop) => prop in target || prop in sdk,
  });

test("itx.slack — a live bridge replays the natural dotted spelling onto the SDK end to end", async () => {
  // ── bridge session (the provider) + a second ordinary client — both on ONE ctx ──
  const ctx = freshCtx("slack");
  const bridgeItx = openItx(ctx);
  // ONE provide door: the live bridge stub mounts AT itx.slack (the path is its identity).
  await bridgeItx.provide("itx.slack", new SlackReplayTarget());

  const itx = openItx(ctx);

  // 1. THE HEADLINE (this file's line-5 promise): the NATURAL DOTTED spelling every client writes
  //    — plain property access on the capnweb stub — replayed end to end (slack → chat →
  //    postMessage). This is the prototype-hop dotted surface (core/dotted-path-proxy.ts): unknown
  //    segments accumulate into ONE invokeCapability dispatch. No client SDK, just capnweb.
  const posted = await itx.slack.chat.postMessage({ channel: "#general", text: "hello from itx" });
  // itx.slack.chat.postMessage(...) — the NATURAL DOTTED spelling — replays onto the SDK
  expect(posted?.ok).toBe(true);
  expect(posted?.ts).toBe("1755.000100");
  expect(posted?.channel).toBe("#general");
  // the bridge-side SDK instance received the exact dotted call
  expect(sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.text === "hello from itx")).toBe(
    true,
  );

  // 1b. the SAME call via the explicit door (the desugared form the dotted spelling compiles to)
  const postedExplicit = await itx.invokeCapability([
    "itx",
    "slack",
    "chat",
    ["postMessage", { channel: "#general", text: "via explicit door" }],
  ]);
  // itx.invokeCapability(Expression) — the structured half — answers identically
  expect(postedExplicit?.ok).toBe(true);
  expect(postedExplicit?.channel).toBe("#general");

  // 2. the same thing through the GENERIC expression door (the string half)
  const listed = await itx.invokeCapability(`itx.slack.conversations.list({ limit: 10 })`);
  // itx.slack.conversations.list({limit}) via the expression door
  expect(listed?.ok).toBe(true);
  expect(listed?.channels?.length).toBe(2);
  expect(listed.channels[0].name).toBe("general");

  // 3. a mounted alias can shadow-route ONTO the live bridge like any capability
  await itx.provide("itx.notify", "itx.slack.chat.postMessage");
  const aliased = await itx.invokeCapability(
    `itx.notify({ channel: '#alerts', text: 'aliased!' })`,
  );
  // an alias mount (itx.notify ⇒ itx.slack.chat.postMessage) replays through the same bridge
  expect(aliased?.ok).toBe(true);
  expect(sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#alerts")).toBe(true);

  // 4. the SAME thing with ZERO declarations: replay literally onto the SDK instance
  await bridgeItx.provide("itx.slack2", replayOnto(slackSdk));
  const posted2 = await itx.invokeCapability([
    "itx",
    "slack2",
    "chat",
    ["postMessage", { channel: "#zero", text: "no rpctarget declared" }],
  ]);
  // replayOnto(sdk): the LITERAL SDK instance replayed with no per-method declarations
  expect(posted2?.ok).toBe(true);
  expect(sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#zero")).toBe(true);
  await bridgeItx.revoke("itx.slack2");

  // 5. the PROVIDER revokes by path → the mount pops (default-deny answers: NO_CAPABILITY_MATCH,
  //    never "offline" — an explicit revoke removes the row) AND the bridge session closes its own
  //    parked stub under the path.
  await bridgeItx.revoke("itx.slack");
  const denied = await until("revoke propagated", async () => {
    try {
      await itx.invokeCapability([
        "itx",
        "slack",
        "chat",
        ["postMessage", { channel: "#x", text: "y" }],
      ]);
      return undefined; // still routed — keep waiting
    } catch (e) {
      return String(e);
    }
  });
  // after revoke("itx.slack") the capability is gone (default-deny — the ONE code an explicit
  // revoke yields)
  expect(denied).toMatch(/no capability matches/);
  expect(denied).not.toMatch(/offline/);
});

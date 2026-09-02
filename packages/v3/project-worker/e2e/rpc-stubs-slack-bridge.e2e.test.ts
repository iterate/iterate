// rpc-stubs-slack-bridge.e2e.test.ts — THE SLACK SDK USE CASE: `itx.slack` is a LIVE provided rpc
// stub. A local node script (this file — in production a tiny bridge daemon) connects to /api over
// capnweb and provides an RpcTarget that REPLAYS dotted calls onto a Slack WebClient-shaped SDK
// instance (faked here with the exact call surface; swap in `new WebClient(token)` for real). Every
// other client of the project then just speaks `itx.slack.chat.postMessage(...)` and the call rides:
// capnweb → relay → context DO rewrite rules → the borrowed rpc stub (page → invoke) → this script →
// the SDK. Disposing the provided handle (or the bridge dying) recalls the stub and un-sets its rule.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { codeOf, freshCtx, openItx, until } from "./support/client.ts";
import { SlackReplayTarget } from "./support/targets.ts";

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
  const slack = new SlackReplayTarget();
  // ONE provide door: the live bridge stub is lent under itx.slack with the rule at the same spelling.
  const slackProvided = await bridgeItx.provide("itx.slack", slack);

  const itx = openItx(ctx);

  // 1. THE HEADLINE: the NATURAL DOTTED spelling every client writes — plain property access on the
  //    capnweb stub — replayed end to end (slack → chat → postMessage). This is the prototype-hop
  //    dotted surface (context/dotted-path-proxy.ts): unknown segments accumulate into ONE
  //    invoke dispatch. No client SDK, just capnweb.
  const posted = await itx.slack.chat.postMessage({ channel: "#general", text: "hello from itx" });
  expect(posted?.ok).toBe(true);
  expect(posted?.ts).toBe("1755.000100");
  expect(posted?.channel).toBe("#general");
  // the bridge-side SDK instance received the exact dotted call
  expect(slack.calls).toContainEqual([
    "chat.postMessage",
    { channel: "#general", text: "hello from itx" },
  ]);

  // 1b. the SAME call via the explicit door (the desugared form the dotted spelling compiles to)
  const postedExplicit = await itx.invoke([
    "itx",
    "slack",
    "chat",
    ["postMessage", { channel: "#general", text: "via explicit door" }],
  ]);
  expect(postedExplicit?.ok).toBe(true);
  expect(postedExplicit?.channel).toBe("#general");

  // 2. the same thing through the GENERIC expression door (the string half)
  const listed = await itx.invoke(`itx.slack.conversations.list({ limit: 10 })`);
  expect(listed?.ok).toBe(true);
  expect(listed?.channels?.length).toBe(2);
  expect(listed.channels[0].name).toBe("general");

  // 3. a pure rewrite rule can target the live bridge like any other expression
  await itx.provide("itx.notify", "itx.slack.chat.postMessage");
  const rewritten = await itx.invoke(`itx.notify({ channel: '#alerts', text: 'rewritten!' })`);
  expect(rewritten?.ok).toBe(true);
  expect(slack.calls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#alerts")).toBe(
    true,
  );

  // 4. the SAME thing with ZERO declarations: replay literally onto an SDK instance
  const sdkCalls: unknown[] = [];
  const slackSdk = {
    chat: {
      postMessage: async (opts: Record<string, unknown>) => {
        sdkCalls.push(opts);
        return { ok: true, channel: opts.channel };
      },
    },
  };
  const slack2Provided = await bridgeItx.provide("itx.slack2", replayOnto(slackSdk));
  const posted2 = await itx.invoke([
    "itx",
    "slack2",
    "chat",
    ["postMessage", { channel: "#zero", text: "no rpctarget declared" }],
  ]);
  expect(posted2?.ok).toBe(true);
  expect(sdkCalls).toEqual([{ channel: "#zero", text: "no rpctarget declared" }]);
  slack2Provided[Symbol.dispose]();

  // 5. the PROVIDER disposes its handle → the stub is recalled AND the rule is un-set (default-deny
  //    answers: NO_ITX_EXPRESSION_MATCH, never "offline" — the un-set removes the rule).
  slackProvided[Symbol.dispose]();
  const denied = await until("the dispose propagated", async () => {
    try {
      await itx.invoke(["itx", "slack", "chat", ["postMessage", { channel: "#x", text: "y" }]]);
      return undefined; // still routed — keep waiting
    } catch (e) {
      return e as Error;
    }
  });
  expect(codeOf(denied)).toBe("NO_ITX_EXPRESSION_MATCH");
});

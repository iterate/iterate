// prove_slack.mjs — THE SLACK SDK USE CASE: `itx.slack` is a LIVE provided capability. A local
// node script (this file — in production a tiny bridge daemon) connects to /api over capnweb
// and provides an RpcTarget that REPLAYS dotted calls onto a Slack WebClient-shaped SDK
// instance (faked here with the exact call surface; swap in `new WebClient(token)` for real).
// Every other client of the project then just speaks `itx.slack.chat.postMessage(...)` and the
// call rides: capnweb → relay → stream DO table → hibernatable RPC stub (page → invoke) → this
// script → the SDK. Revoking the provision (or the bridge dying) takes the mount with it.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_slack${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

// ── the "real" SDK instance (WebClient shape; records what it was asked to do) ──
const sdkCalls = [];
const slackSdk = {
  chat: {
    postMessage: async (opts) => {
      sdkCalls.push(["chat.postMessage", opts]);
      return { ok: true, ts: "1755.000100", channel: opts.channel };
    },
  },
  conversations: {
    list: async (opts) => {
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
    return { postMessage: (opts) => slackSdk.chat.postMessage(opts) };
  }
  get conversations() {
    return { list: (opts) => slackSdk.conversations.list(opts) };
  }
}

/** THE ZERO-DECLARATION SHAPE (the apps/os replayPathCall idea, pushed to the client): a Proxy
 *  over a bare RpcTarget forwards every unknown property straight to the LITERAL SDK instance —
 *  no per-method table, no getters; `new WebClient(token)` drops in as `sdk` unchanged. (capnweb
 *  only passes RpcTargets/functions by reference, so the bare-RpcTarget core is what crosses;
 *  the Proxy fills its property surface from the SDK.) */
const replayOnto = (sdk) =>
  new Proxy(new (class extends RpcTarget {})(), {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : sdk[prop]),
    has: (target, prop) => prop in target || prop in sdk,
  });

// ── bridge session (the provider) + a second ordinary client ──
const bridgeSession = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const bridgeItx = await bridgeSession.authenticate().get();
const provision = await bridgeItx.provideCapability({
  type: "live",
  path: ["slack"],
  capability: new SlackReplayTarget(),
  instructions: "slack sdk bridge (node script)",
});

const clientSession = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await clientSession.authenticate().get();

// 1. THE HEADLINE (this file's line-5 promise): the NATURAL DOTTED spelling every client writes
//    — plain property access on the capnweb stub — replayed end to end (slack → chat →
//    postMessage). This is the prototype-hop dotted surface (core/dotted-path-proxy.ts): unknown
//    segments accumulate into ONE invokeCapability dispatch. No client SDK, just capnweb.
const posted = await itx.slack.chat.postMessage({ channel: "#general", text: "hello from itx" });
check(
  posted?.ok === true && posted?.ts === "1755.000100" && posted?.channel === "#general",
  "itx.slack.chat.postMessage(...) — the NATURAL DOTTED spelling — replays onto the SDK",
  JSON.stringify(posted),
);
check(
  sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.text === "hello from itx"),
  "the bridge-side SDK instance received the exact dotted call",
  JSON.stringify(sdkCalls.at(-1)),
);
// 1b. the SAME call via the explicit door (the desugared form the dotted spelling compiles to)
const postedExplicit = await itx.invokeCapability({
  path: ["slack", "chat", "postMessage"],
  args: [{ channel: "#general", text: "via explicit door" }],
});
check(
  postedExplicit?.ok === true && postedExplicit?.channel === "#general",
  "itx.invokeCapability({path,args}) — the explicit door — answers identically",
  JSON.stringify(postedExplicit),
);
// 2. the same thing through the GENERIC expression door (the string half)
const listed = await itx.invoke(`itx.slack.conversations.list({ limit: 10 })`);
check(
  listed?.ok === true && listed?.channels?.length === 2 && listed.channels[0].name === "general",
  "itx.slack.conversations.list({limit}) via the expression door",
  JSON.stringify(listed?.channels),
);

// 3. a mounted alias can shadow-route ONTO the live bridge like any capability
await itx.provide({ path: "itx.notify", target: "itx.slack.chat.postMessage" });
const aliased = await itx.invoke(`itx.notify({ channel: '#alerts', text: 'aliased!' })`);
check(
  aliased?.ok === true &&
    sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#alerts"),
  "an alias mount (itx.notify ⇒ itx.slack.chat.postMessage) replays through the same bridge",
  JSON.stringify(aliased),
);

// 4. the SAME thing with ZERO declarations: replay literally onto the SDK instance
const provision2 = await bridgeItx.provideCapability({
  type: "live",
  path: ["slack2"],
  capability: replayOnto(slackSdk),
  instructions: "slack sdk bridge, zero-declaration replay",
});
const posted2 = await itx.invokeCapability({
  path: ["slack2", "chat", "postMessage"],
  args: [{ channel: "#zero", text: "no rpctarget declared" }],
});
check(
  posted2?.ok === true &&
    sdkCalls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#zero"),
  "replayOnto(sdk): the LITERAL SDK instance replayed with no per-method declarations",
  JSON.stringify(posted2),
);
await provision2.revoke();

// 5. revoke the provision → the mount is gone, default-deny answers
await provision.revoke();
const denied = await until("revoke propagated", async () => {
  try {
    await itx.invokeCapability({
      path: ["slack", "chat", "postMessage"],
      args: [{ channel: "#x", text: "y" }],
    });
    return undefined; // still routed — keep waiting
  } catch (e) {
    return String(e);
  }
});
check(
  /no capability matches|offline/.test(denied),
  "after provision.revoke() the capability is gone (default-deny)",
  denied.slice(0, 90),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

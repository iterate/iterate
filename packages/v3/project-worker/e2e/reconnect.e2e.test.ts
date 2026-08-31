// reconnect.e2e.test.ts — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY, live.
//
// A capability PROVIDER is ephemeral: its capnweb WebSocket terminates at a STATELESS `/api` worker,
// and Cloudflare documents that a plain worker cannot durably hold a WebSocket (the isolate can be
// recycled, taking the socket + in-memory retained callback with it — capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So a provider dropping is EXPECTED;
// the platform's answer is RECONNECT under the same key, not server durability.
//
// This proves it against the real deployment: a provider goes OFFLINE (its session is disposed → the
// WS closes → the DO drops the stub) and re-provides under the SAME key, after which its capability
// is callable AGAIN through `itx.rpcStubs.get(key)`. This is the property the live hibernation proofs
// tried to force by waiting on Cloudflare — proven here deterministically by controlling the
// disconnect.
// (was proofs/prove_reconnect.mjs)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { bareItx, freshCtx, session, until } from "./support/client.ts";

// Disposing our own provider session mid-test surfaces the capnweb peer-close as an unhandled
// rejection — the deliberate disconnect, not a failure. The e2e config's onUnhandledError filter
// absorbs exactly that transport noise (e2e/vitest.config.ts); everything else stays fatal.
const DISPOSE: symbol = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose");

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

test("a provider drops and re-provides under the same key — the capability is callable again", async () => {
  // the consumer stays connected throughout and addresses the provider BY KEY. Every session in this
  // test shares ONE ctx (one project DO).
  const ctx = freshCtx("recon");
  const itx = bareItx(ctx);

  // 1. provider provides a live capability under key 'p' → callable through the key.
  let providerSession = session(ctx);
  await providerSession.get().rpcStubs.provide(new Tools("v1"), { key: "p" });
  const online = await until("callable online", async () =>
    (await itx.invokeCapability("itx.rpcStubs.get('p').echo('a')")) === "echo-v1:a"
      ? true
      : undefined,
  );
  expect(online).toBe(true); // 1. provider online: itx.rpcStubs.get('p').echo() answers

  // 2. provider goes OFFLINE — dispose its session (WS closes → the DO drops stub 'p').
  providerSession[DISPOSE]?.();
  const offline = await until("provider offline", async () => {
    try {
      await itx.invokeCapability("itx.rpcStubs.get('p').echo('b')");
      return undefined; // still answering — keep polling
    } catch {
      return true; // CONNECTION_OFFLINE — the drop landed
    }
  });
  expect(offline).toBe(true); // 2. provider offline: the key stops answering after the session drops

  // 3. provider RE-PROVIDES under the SAME key with a fresh capability instance.
  providerSession = session(ctx);
  await providerSession.get().rpcStubs.provide(new Tools("v2"), { key: "p" });

  // 4. THE CONTRACT: the capability is callable AGAIN through the same key — it resolves to the
  //    reconnected provider (v2), with no re-addressing by the caller.
  const after = await until("callable after reconnect", async () => {
    const r = await itx.invokeCapability("itx.rpcStubs.get('p').echo('c')");
    return r === "echo-v2:c" ? r : undefined;
  });
  expect(after).toBe("echo-v2:c"); // 3. reconnect under the SAME key: the capability is callable again
});

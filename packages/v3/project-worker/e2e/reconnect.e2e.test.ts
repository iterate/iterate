// reconnect.e2e.test.ts — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY, live.
//
// A capability PROVIDER is ephemeral: its capnweb WebSocket terminates at a STATELESS `/api` worker,
// and Cloudflare documents that a plain worker cannot durably hold a WebSocket (the isolate can be
// recycled, taking the socket + in-memory retained callback with it — capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So a provider dropping is EXPECTED;
// the platform's answer is RECONNECT at the same capability path, not server durability.
//
// This proves it against the real deployment: a provider goes OFFLINE (its session is disposed → the
// WS closes → the DO drops the stub) and re-provides at the SAME path — which REPLACES the transport
// and supersedes the live row in place (one row per path) — after which its capability is callable
// AGAIN through the same dotted path. This is the property the live hibernation proofs tried to
// force by waiting on Cloudflare — proven here deterministically by controlling the disconnect.
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

test("a provider drops and re-provides at the same path — the capability is callable again", async () => {
  // the consumer stays connected throughout and addresses the provider BY PATH (the mount path IS
  // the live stub's identity). Every session in this test shares ONE ctx (one project DO).
  const ctx = freshCtx("recon");
  const itx = bareItx(ctx);

  // 1. provider provides a live capability at itx.p → callable through the path.
  let providerSession = session(ctx);
  await providerSession.get().provide("itx.p", new Tools("v1"));
  const online = await until("callable online", async () =>
    (await itx.invokeCapability("itx.p.echo('a')")) === "echo-v1:a" ? true : undefined,
  );
  expect(online).toBe(true); // 1. provider online: itx.p.echo() answers

  // 2. provider goes OFFLINE — dispose its session (WS closes → the DO drops the itx.p transport).
  providerSession[DISPOSE]?.();
  const offline = await until("provider offline", async () => {
    try {
      await itx.invokeCapability("itx.p.echo('b')");
      return undefined; // still answering — keep polling
    } catch {
      return true; // the drop landed (CONNECTION_OFFLINE, or NO_CAPABILITY_MATCH once auto-revoke pops the row)
    }
  });
  expect(offline).toBe(true); // 2. provider offline: the path stops answering after the session drops

  // 3. provider RE-PROVIDES at the SAME path with a fresh capability instance — this REPLACES the
  //    transport and supersedes the live row in place (one row per path).
  providerSession = session(ctx);
  await providerSession.get().provide("itx.p", new Tools("v2"));

  // 4. THE CONTRACT: the capability is callable AGAIN through the same path — it resolves to the
  //    reconnected provider (v2), with no re-addressing by the caller.
  const after = await until("callable after reconnect", async () => {
    const r = await itx.invokeCapability("itx.p.echo('c')");
    return r === "echo-v2:c" ? r : undefined;
  });
  expect(after).toBe("echo-v2:c"); // 3. reconnect at the SAME path: the capability is callable again
});

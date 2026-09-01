// reconnect.e2e.test.ts — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY, live.
//
// A capability PROVIDER is ephemeral: its capnweb WebSocket terminates at a STATELESS `/api` worker,
// and Cloudflare documents that a plain worker cannot durably hold a WebSocket (the isolate can be
// recycled, taking the socket + in-memory retained callback with it — capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So a provider dropping is EXPECTED;
// the platform's answer is RECONNECT at the same capability path, not server durability.
//
// This proves it against the real deployment: a provider goes OFFLINE (its session is disposed → the
// WS closes → the DO drops the stub from the `itx.rpcStubs` registry) and re-provides at the SAME
// path — which re-parks under the same registry key (the transport is REPLACED) while the MOUNT,
// pure data naming that key, never moved: the door answers the existing mount's identity and
// appends NOTHING. The capability is callable AGAIN through the same dotted path. In between, the
// path answers CONNECTION_OFFLINE — mounted-but-offline, never default-deny: nothing auto-revokes
// a mount because a socket dropped. This is the property the live hibernation proofs tried to
// force by waiting on Cloudflare — proven here deterministically by controlling the disconnect.
// (was proofs/prove_reconnect.mjs)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { openItx, freshCtx, session, until } from "./support/client.ts";

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

const PROVIDED = "events.iterate.com/capability-table/capability-provided";
/** The durable log's mount events at `itx.p` — the reconnect must add none. */
const providedAtP = (page: { events: { type: string; payload?: { path?: string } }[] }) =>
  page.events.filter((e) => e.type === PROVIDED && e.payload?.path === "itx.p");

test("a provider drops and re-provides at the same path — offline in between (the mount stays), callable again, ZERO events", async () => {
  // the consumer stays connected throughout and addresses the provider BY PATH (the mount path IS
  // the registry key the stub is parked under). Every session in this test shares ONE ctx (one
  // project DO).
  const ctx = freshCtx("recon");
  const itx = openItx(ctx);
  const mountsAtP = async (): Promise<unknown[]> =>
    (
      await itx.invokeCapability("itx.facets.get('capability-table').snapshot()")
    ).state.mounts.filter((m: { path: string[] }) => m.path.join(".") === "itx.p");

  // 1. provider provides a live capability at itx.p → callable through the path.
  let providerSession = session();
  const first = await providerSession
    .authenticate()
    .projects.get(ctx)
    .provide("itx.p", new Tools("v1"));
  const online = await until("callable online", async () =>
    (await itx.invokeCapability("itx.p.echo('a')")) === "echo-v1:a" ? true : undefined,
  );
  expect(online).toBe(true); // 1. provider online: itx.p.echo() answers

  // 2. provider goes OFFLINE — dispose its session (WS closes → the DO drops the itx.p transport).
  //    The path answers CONNECTION_OFFLINE — ONLY that code: the mount is still in the table (no
  //    auto-revoke ever pops a mount because a socket dropped), so it is never default-deny.
  providerSession[DISPOSE]?.();
  const offline = await until("provider offline", async () => {
    try {
      await itx.invokeCapability("itx.p.echo('b')");
      return undefined; // still answering — keep polling
    } catch (e) {
      return e as { code?: string };
    }
  });
  expect(offline?.code).toBe("CONNECTION_OFFLINE"); // 2. mounted-but-offline, not NO_CAPABILITY_MATCH
  expect(await mountsAtP()).toHaveLength(1); // the mount STAYED
  const logBefore = await itx.invokeCapability("itx.read(0, 500)");

  // 3. provider RE-PROVIDES at the SAME path with a fresh capability instance — this re-parks
  //    under the same registry key (REPLACING the transport) and re-provides the SAME mount, which
  //    the door answers with the existing mount's identity: ZERO events.
  providerSession = session();
  const second = await providerSession
    .authenticate()
    .projects.get(ctx)
    .provide("itx.p", new Tools("v2"));
  expect(second.providedAtOffset).toBe(first.providedAtOffset); // the door handed back the one mount

  // 4. THE CONTRACT: the capability is callable AGAIN through the same path — it resolves to the
  //    reconnected provider (v2), with no re-addressing by the caller.
  const after = await until("callable after reconnect", async () => {
    const r = await itx.invokeCapability("itx.p.echo('c')");
    return r === "echo-v2:c" ? r : undefined;
  });
  expect(after).toBe("echo-v2:c"); // 3. reconnect at the SAME path: the capability is callable again

  // 5. RECONNECT APPENDS NO EVENT: the log holds exactly the one mount at itx.p it held before the
  //    re-provide, and the table still holds exactly one row there.
  const logAfter = await itx.invokeCapability("itx.read(0, 500)");
  expect(providedAtP(logAfter)).toHaveLength(providedAtP(logBefore).length);
  expect(providedAtP(logAfter)).toHaveLength(1);
  expect(logAfter.events.length).toBe(logBefore.events.length);
  expect(await mountsAtP()).toHaveLength(1);
});

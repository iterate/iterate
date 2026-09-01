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
import {
  openItx,
  freshCtx,
  presence,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";

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

// The same property one layer up (was resub-zombie.e2e): a LIVE SUBSCRIBER is a stub parked under
// `itx.subscriptions.<name>` plus one subscription row naming it. Re-subscribing the same name
// re-parks under the same key — the session disposes the first relay (its transport is REPLACED, the
// first callback physically unreachable) — and the identical row appends NOTHING (same name
// replaces; there is no shadow stack). `unsubscribe(name)` drops the one row and closes this
// session's stub: no callback under that name receives anything afterwards.
test("a live subscriber re-subscribes under the same name — the transport is replaced (one row, zero events); unsubscribe stops delivery for good", async () => {
  const itx = openItx(freshCtx("resub"));
  await itx.append({ type: "seed" });
  const rowsNamed = async (name: string): Promise<unknown[]> =>
    (await subscriptions(itx)).filter((r: { name: string }) => r.name === name);

  // ── CONTROL: a single live subscribe delivers; unsubscribe(name) stops it ──
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
  await itx.unsubscribe("control");
  expect(await rowsNamed("control")).toHaveLength(0);
  await itx.append({ type: "ctl", payload: { n: 2 } });
  await sleep(1500);
  expect(ctrl).toBe(1); // NO delivery after unsubscribe

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
  // the identical row appended NOTHING, the table holds ONE row named s, and the key is present
  const logAfter = await itx.read(0, 500);
  expect(logAfter.events.length).toBe(logBefore.events.length);
  expect(await rowsNamed("s")).toHaveLength(1);
  expect(await presence(itx)).toContain("itx.subscriptions.s");

  await itx.append({ type: "mark", payload: { n: 1 } });
  await until("cb2 delivered", () => cb2 === 1);
  await sleep(1000);
  expect(cb1).toBe(0); // only the newest callback is reachable — cb1's transport was replaced

  // ── unsubscribe once: the row and this session's stub are gone; nobody under s hears the next mark ──
  await itx.unsubscribe("s");
  expect(await rowsNamed("s")).toHaveLength(0);
  await until("stub closed", async () => !(await presence(itx)).includes("itx.subscriptions.s"));
  await itx.append({ type: "mark", payload: { n: 2 } });
  await sleep(1500);
  expect(cb1).toBe(0);
  expect(cb2).toBe(1);
});

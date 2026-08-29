// __tests__/reconnect-same-key.test.ts — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY.
//
// A capability PROVIDER is ephemeral. The client capnweb WebSocket terminates at a STATELESS `/api`
// worker, and Cloudflare documents that a plain worker cannot durably hold a WebSocket — "if the
// isolate is evicted, the connection is lost because there is no persistent actor to hold it"
// (workers-best-practices; capnweb-in-a-DO is the still-open workerd#6087, whose own suggested
// workaround IS a stateless proxy worker). So a provider socket dropping is EXPECTED, and the
// platform's answer is RECONNECT, not server-side durability.
//
// The `connectionKey` is the DURABLE identity. This pins the contract: a provider that goes OFFLINE
// (its session drops) and reconnects under the SAME key is reachable again through
// `itx.connections.get(key)` — its capability can be called later. Fully deterministic (we control
// the disconnect), so it proves — reliably, in CI — the property the live hibernation proofs could
// only race Cloudflare for. See reference: the live hibernation proofs are inherently flaky; THIS is
// the property that actually matters in production.

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

const RUN = Date.now().toString(36);
const c = (name: string) => `prj_recon${RUN}_${name}`;
const DISPOSE: symbol = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose");

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

/** Poll until `fn` returns truthy (deadline, never a bare sleep). */
async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = `falsy: ${JSON.stringify(v)}`;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline)
      throw new Error(`until(${label}): deadline after ${timeoutMs}ms — last: ${String(last)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A live client capability, tagged so we can tell the pre- and post-reconnect instances apart. */
class Tools extends RpcTarget {
  readonly #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  echo(s: string) {
    return `echo-${this.#tag}:${s}`;
  }
}

test("a provider goes OFFLINE and reconnects under the SAME key — its capability is callable again", async () => {
  const ctx = c("samekey");
  const consumer = await harness.itx(ctx); // stays connected throughout; addresses the provider by key

  // 1. provider connects under key 'p' with a live capability → callable through the key.
  let provider = harness.session(ctx);
  await provider.connect({ connectionKey: "p", capabilities: new Tools("v1") });
  const before = await until("callable while online", async () =>
    (await consumer.invoke("itx.connections.get('p').echo('a')")) === "echo-v1:a"
      ? "ok"
      : undefined,
  );
  expect(before).toBe("ok");

  // 2. provider goes OFFLINE — dispose its capnweb session (the WS closes; the DO reaps connection
  //    'p' when its last transport's pager closes). The consumer's own session is untouched.
  (provider as Record<symbol, () => void>)[DISPOSE]?.();
  await until("provider is OFFLINE (the key stops answering)", async () => {
    try {
      await consumer.invoke("itx.connections.get('p').echo('b')");
      return undefined; // still answering — keep polling until it goes offline
    } catch {
      return true; // CONNECTION_OFFLINE — the reap landed
    }
  });

  // 3. provider RECONNECTS under the SAME key with a fresh capability instance.
  provider = harness.session(ctx);
  await provider.connect({ connectionKey: "p", capabilities: new Tools("v2") });

  // 4. THE CONTRACT: the capability is callable AGAIN through the same key — it now resolves to the
  //    reconnected provider (the v2 instance), no re-address needed by the caller.
  const after = await until("callable again after reconnect under the same key", async () => {
    const r = await consumer.invoke("itx.connections.get('p').echo('c')");
    return r === "echo-v2:c" ? r : undefined;
  });
  expect(after).toBe("echo-v2:c");
});

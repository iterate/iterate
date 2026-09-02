// __workers-tests__/support.ts — what every file in the workers lane (the vitest project that runs
// INSIDE workerd, next to the worker) shares: the context DO stub by ctx name, a capnweb session
// over SELF's /api (disposed at teardown — importing this module registers the afterAll), a live
// value to lend (`Echo`, tagged per instance), and the production 60s idle quiesce reproduced on
// demand.
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, vi } from "vitest";
import { DurableObjectNameCodec } from "../src/context/durable-object-names.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";

/** The context DO for a ctx name (a project id or a full codec name), through the CONTEXT
 *  binding — the raw Workers-RPC stub, which is this lane's whole point: the DO's verbs with no
 *  edge reducing the returns away, plus runInDurableObject over the same instance. */
export const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(DurableObjectNameCodec.parse(ctx).name);

/** One client's rpc stub, lent under its key: the per-instance tag (`echo-<i>:<s>`) proves no
 *  crosstalk. Provided as `itx.provide(rpcStubKey, new Echo(i), { rewrite: rpcStubKey })`, so
 *  the key is also the dotted match a caller spells. */
export class Echo extends RpcTarget {
  readonly #i: number;
  constructor(i: number) {
    super();
    this.#i = i;
  }
  echo(s: string): string {
    return `echo-${this.#i}:${s}`;
  }
}

// capnweb sessions live for the whole file; disposed at teardown (sessions left open turn into
// unhandled-rejection noise).
const sessions: unknown[] = [];
/** Open a capnweb session to the worker over a WebSocket upgrade on SELF.fetch —
 *  newWebSocketRpcSession accepts the existing (accepted) socket per its typings. */
export async function openSession(): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}
afterAll(async () => {
  if (sessions.length === 0) return;
  // Let any fire-and-forget page/alarm cleanup drain before the lane's RPC bridge is torn down —
  // otherwise a still-pending resolve surfaces as a (harmless) EnvironmentTeardownError.
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
});

/** Reproduce the production 60s idle quiesce ON DEMAND: fake Date ONLY (+61s — sockets, the alarm
 *  scheduler and real timers stay real), fire the armed alarm (runDurableObjectAlarm runs a
 *  scheduled alarm immediately), restore real time. The alarm's quiesce branch aborts every idle
 *  facet and returns every borrowed stub, making the DO dormant — which is also
 *  evictDurableObject's de-facto precondition: a materialized facet or a borrowed stub PINS the DO
 *  non-hibernatable (workerd#6800), and evicting such a DO times out after 30s on "still has active
 *  references". You must quiesce BEFORE you can evict — the exact production sequence.
 *
 *  NOTE the precondition: the quiet clock ARMS only while a facet is live or a stub is borrowed, so
 *  a context with neither has no alarm and this is a no-op. */
export async function quiesce(ctx: string): Promise<void> {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(stub(ctx));
  } finally {
    vi.useRealTimers();
  }
}

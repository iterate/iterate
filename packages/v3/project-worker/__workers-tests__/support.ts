// __workers-tests__/support.ts — what every file in the workers lane (the vitest project that runs
// INSIDE workerd, next to the worker) shares: the context DO stub by ctx name, a capnweb session
// over SELF's /api (disposed at teardown — importing this module registers the afterAll), a live
// value to lend (`Echo`, tagged per instance), the directory schema into this lane's empty D1, the
// production 60s idle quiesce reproduced on demand, and the one poll-until.
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, vi } from "vitest";
import definitionsSql from "../src/control-plane.sql?raw";
import { DurableObjectNameCodec } from "../src/iterate-context.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";

/** The context DO for a ctx name (a project id or a full codec name), through the ITERATE_CONTEXT
 *  binding — the raw Workers-RPC stub, which is this lane's whole point: the DO's verbs with no
 *  edge reducing the returns away, plus runInDurableObject over the same instance. */
export const stub = (ctx: string) =>
  (
    env as unknown as { ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).ITERATE_CONTEXT.getByName(DurableObjectNameCodec.parse(ctx).name);

/** One client's rpc stub, lent under its key: the per-instance tag (`echo-<i>:<s>`) proves no
 *  crosstalk. Provided as `itx.provide(rpcStubKey, new Echo(i))`, so
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

/** THE DIRECTORY SCHEMA (src/control-plane.sql) into this lane's D1 — fresh and empty per file — the
 *  same split-and-batch the e2e global-setup does; a file whose sessions create or list projects
 *  runs it in `beforeAll`. Idempotent (IF NOT EXISTS). */
export async function applyDirectorySchema(): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  const statements = definitionsSql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

/** This lane's admin secret (wrangler.test.jsonc `APP_CONFIG_ADMIN_API_SECRET`). */
const adminApiSecret = (): string =>
  String((env as unknown as { APP_CONFIG_ADMIN_API_SECRET: string }).APP_CONFIG_ADMIN_API_SECRET);
/** THE lane's credentials (src/session.ts): the admin secret — every project, `{ actor: "admin" }`. */
export const adminCredentials = () => ({ type: "admin-secret" as const, secret: adminApiSecret() });
/** The same secret as a lane's bearer — what a raw request to `/expression` is admitted with. */
export const adminBearer = (): { authorization: string } => ({
  authorization: `Bearer ${adminApiSecret()}`,
});

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
 *  NOTE the precondition: the quiet clock ARMS only while a facet is live or a stub is borrowed (the
 *  cursor lane arms the alarm for its own deliveries, subscription-delivery.ts), so a context with
 *  none of those has no alarm and this is a no-op. */
export async function quiesce(ctx: string): Promise<void> {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(stub(ctx));
  } finally {
    vi.useRealTimers();
  }
}

/** Poll `fn` until it returns a defined, non-false value (bounded). Physical facts arrive a beat
 *  after the RPC that triggered them: a pager leaves the census when its CLOSE lands at the DO, a
 *  handle's rule un-set rides the edge's waitUntil, a page reaches a pager over its socket. */
export async function until<T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

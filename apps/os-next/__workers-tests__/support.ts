// __workers-tests__/support.ts — what every file in the workers lane (the vitest project that runs
// INSIDE workerd, next to the worker) shares: the context DO stub by ctx name, a capnweb session
// over SELF's /api (disposed at teardown — importing this module registers the afterAll), a live
// value to lend (`Echo`, tagged per instance), the directory schema into this lane's empty D1, the
// production pins' release on demand, and the one poll-until.
import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll } from "vitest";
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

/** An app that answers with what the platform handed it: the principal stamp, the bearer and the
 *  trusted app label — provided as `itx.apps.<label>` and fetched on a project host. */
export const SRC_ECHO_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
      app: request.headers.get("x-iterate-app"),
    });
  }
}`,
};

// capnweb sessions live for the whole file; disposed at teardown (sessions left open turn into
// unhandled-rejection noise).
const sessions: unknown[] = [];
/** Open a capnweb session to the worker over a WebSocket upgrade on SELF.fetch —
 *  newWebSocketRpcSession accepts the existing (accepted) socket per its typings. */
export async function openSession(): Promise<any> {
  const res = await SELF.fetch(`https://control.test/internal/rpc`, {
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

/** The pins' RELEASE, run directly, plus every live facet aborted: every borrowed stub returned,
 *  every library connection closed — making the DO dormant, which is evictDurableObject's de-facto
 *  precondition here: workerd keeps a DO with a materialized facet or a borrowed stub
 *  non-hibernatable (workerd#6800), and evicting such a DO times out after 30s on "still has active
 *  references". You must release BEFORE you can evict. Run directly: in production the pins'
 *  30 s timer releases them, and a facet is released by nothing but the actor's own end (on the
 *  edge it does not keep the actor resident); a test that wants the alarm PASS itself fakes Date
 *  and calls `runDurableObjectAlarm`. */
export async function releasePins(ctx: string): Promise<void> {
  await runInDurableObject(stub(ctx), (instance) => {
    (instance as IterateContextDurableObject).releasePins();
  });
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

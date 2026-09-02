// e2e/support/client.ts — THE E2E client: open a capnweb session to the one shared worker (URL from
// global-setup, via WORKER_BASE_URL) for a FRESH ctx per test, exactly like a production client. This
// is the whole "how a test reaches the worker" surface — the ported proofs use only this.

// eslint-disable-next-line iterate/no-capnweb-http-batch -- httpBatch() below exists to PROVE the /api one-shot batch door (edge.e2e); everything else is WS
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";

const baseUrl = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

let counter = 0;
/** A unique project ctx per call, so tests never collide on a Durable Object (each ctx is its own). */
export const freshCtx = (prefix: string): string =>
  `prj_${prefix}_${Date.now().toString(36)}_${counter++}`;

const wsApi = (): string => {
  const u = new URL("/api", baseUrl());
  u.protocol = "ws:";
  return u.toString();
};

const openSessions: any[] = [];

/** A raw capnweb session — an `UnauthenticatedSession` stub: `authenticate().projects.get(ctx)` is
 *  the itx. For flows that need the session itself (its identity, its `[Symbol.dispose]`). */
export function session(): any {
  const s = newWebSocketRpcSession(wsApi());
  openSessions.push(s);
  return s;
}

/** THE default door: a fresh session's authenticated itx for a project ctx (its root context).
 *  `.authenticate()` is a no-op gate today; it is the only door — there is no bare one. */
export function openItx(ctx: string): any {
  return session().authenticate().projects.get(ctx);
}

/** A ONE-SHOT HTTP-batch session — a CLI-shaped client, no WebSocket anywhere. Every call chained
 *  off it flushes as a single POST to /api. Same shape: `.authenticate().projects.get(ctx)`. */
export function httpBatch(): any {
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door itself is under test (edge.e2e proves a socketless CLI client works)
  return newHttpBatchRpcSession(new URL("/api", baseUrl()).toString());
}

/** Dispose every session opened since the last call — wired to afterEach in support/setup.ts. */
export function disposeSessions(): void {
  for (const s of openSessions.splice(0)) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The subscriptions table joined with the stream-kept cursors — `itx.subscriptions.list()`, the
 *  layer's read door: `[{ name, target, consumes?, configuredAtOffset, cursor?, halted? }]`. A
 *  cursor is present only for a target the stream delivers at-least-once (one that cannot own its
 *  progress); a processor's row has none (its facet keeps its own checkpoint). */
export async function subscriptions(itx: any): Promise<any[]> {
  return (await itx.subscriptions.list()) as any[];
}

/** PRESENCE — the registry keys with an open transport RIGHT NOW (`itx.rpcStubs.list()`, the
 *  physical built-in). Shrinks when a provider's session dies; a mount never does. */
export async function presence(itx: any): Promise<string[]> {
  return (await itx.rpcStubs.list()) as string[];
}

/** The paths of the table's LIVE MOUNTS — rows whose target names the `itx.rpcStubs` registry.
 *  Pure data: this set does NOT shrink when a provider dies; it shrinks on revoke. */
export async function rpcStubMountPaths(itx: any): Promise<string[]> {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as { path: string[]; target: unknown }[])
    .filter((m) => Array.isArray(m.target) && m.target[0] === "itx" && m.target[1] === "rpcStubs")
    .map((m) => m.path.join("."));
}

/** Enabled processors = subscriptions whose target is a facet's processEventBatch (the load chain). */
export async function processorNames(itx: any): Promise<string[]> {
  return (await subscriptions(itx))
    .filter((s) => /getDurableObjectClass\(.*\)\.get\(.*\)\.processEventBatch$/.test(s.target))
    .map((s) => s.name);
}

/** Poll `fn` until it returns a truthy/defined value or time out. Absorbs transient throws (a call
 *  racing an eviction). */
export const until = async <T>(
  label: string,
  fn: () => T | Promise<T> | undefined | false,
  timeoutMs = 20_000,
): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => undefined);
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await sleep(50);
  }
};

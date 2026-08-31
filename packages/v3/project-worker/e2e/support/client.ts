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

const wsApi = (ctx: string): string => {
  const u = new URL("/api", baseUrl());
  u.protocol = "ws:";
  u.searchParams.set("ctx", ctx);
  return u.toString();
};

const openSessions: any[] = [];

/** The raw capnweb session for a ctx (for flows that need the session identity or `[Symbol.dispose]`). */
export function session(ctx: string): any {
  const s = newWebSocketRpcSession(wsApi(ctx));
  openSessions.push(s);
  return s;
}

/** A fresh authenticated itx for a ctx — the default door (`.authenticate()` is a no-op today). */
export function openItx(ctx: string): any {
  return session(ctx).authenticate().get();
}

/** The BARE `.get()` door — no `.authenticate()` in the chain. Ports whose source proof entered bare
 *  use this, so the suite keeps exercising both entry doors. */
export function bareItx(ctx: string): any {
  return session(ctx).get();
}

/** A ONE-SHOT HTTP-batch session for a ctx — a CLI-shaped client, no WebSocket anywhere. Every call
 *  chained off it flushes as a single POST to /api. */
export function httpBatch(ctx: string): any {
  const u = new URL("/api", baseUrl());
  u.searchParams.set("ctx", ctx);
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door itself is under test (edge.e2e proves a socketless CLI client works)
  return newHttpBatchRpcSession(u.toString());
}

/** Dispose every session opened since the last call — wired to afterEach in support/setup.ts. */
export function disposeSessions(): void {
  const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
  for (const s of openSessions.splice(0)) {
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

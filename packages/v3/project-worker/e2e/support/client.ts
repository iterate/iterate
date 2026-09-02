// e2e/support/client.ts — THE E2E client: open a capnweb session to the one shared worker (URL from
// global-setup, via WORKER_BASE_URL) for a FRESH ctx per test, exactly like a production client. This
// is the whole "how a test reaches the worker" surface, plus the handful of idioms every file used
// to copy (poll-until, must-reject, the delivery collector, the eyeball WebSocket round trip).

// eslint-disable-next-line iterate/no-capnweb-http-batch -- httpBatch() below exists to PROVE the /api one-shot batch door (session-doors.e2e); everything else is WS
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";

const baseUrl = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

/** A URL on the one shared worker — for the raw HTTP doors that have no itx method (/cap, /version). */
export const workerUrl = (path: string): string => new URL(path, baseUrl()).toString();

/** The /cap door for `cap` in `ctx`, as http or ws. */
export const capUrl = (ctx: string, cap: string, scheme: "http" | "ws"): string => {
  const u = new URL("/cap", baseUrl());
  u.protocol = `${scheme}:`;
  u.searchParams.set("context", ctx);
  u.searchParams.set("cap", cap);
  return u.toString();
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
const openSockets: WebSocket[] = [];

/** A raw capnweb session — an `UnauthenticatedSession` stub: `authenticate().projects.get(ctx)` is
 *  the itx. For flows that need the session itself (its identity, its `[Symbol.dispose]`). */
export function session(): any {
  const s = newWebSocketRpcSession(wsApi());
  openSessions.push(s);
  return s;
}

/** A capnweb session whose underlying WebSocket WE hold — so a test can sever the transport
 *  (network death, no capnweb goodbye) or instrument its frames: `prepare(ws)` runs BEFORE capnweb
 *  attaches, so a wrapped `send` / an early "message" listener sees every frame in wire order. */
export function rawSession(prepare?: (ws: WebSocket) => void): { session: any; ws: WebSocket } {
  const ws = new WebSocket(wsApi());
  openSockets.push(ws);
  prepare?.(ws);
  const s = newWebSocketRpcSession(ws as any) as any;
  openSessions.push(s);
  return { session: s, ws };
}

/** THE default door: a fresh session's authenticated itx for a project ctx (its root context).
 *  `.authenticate()` is a no-op gate today; it is the only door — there is no bare one. */
export function openItx(ctx: string): any {
  return session().authenticate().projects.get(ctx);
}

/** A ONE-SHOT HTTP-batch session — a CLI-shaped client, no WebSocket anywhere. Every call chained
 *  off it flushes as a single POST to /api. Same shape: `.authenticate().projects.get(ctx)`. */
export function httpBatch(): any {
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door itself is under test (session-doors.e2e proves a socketless CLI client works)
  return newHttpBatchRpcSession(new URL("/api", baseUrl()).toString());
}

/** Dispose every session (and close every raw socket) opened since the last call — wired to
 *  afterEach in support/setup.ts. */
export function disposeSessions(): void {
  for (const s of openSessions.splice(0)) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the stream, through the ONE dispatch door ──

/** `itx.append(...events)` spelled as an expression — one commit, one receipt per input. */
export const append = (itx: any, ...events: unknown[]): Promise<any[]> =>
  itx.invokeCapability(["itx", ["append", ...events]]);

/** The first 500 durable rows of the log. */
export const readAll = async (itx: any): Promise<any[]> =>
  (await itx.invokeCapability(["itx", ["read", 0, 500]])).events;

/** The DURABLE head — the last durable row's offset, NOT scannedThroughOffset (ephemerals such as
 *  live-state deltas consume offsets past it; a facet only ever needs to catch up to the durable
 *  head, which is what "has it reduced the log" means). */
export const readHead = async (itx: any): Promise<number> => {
  const events = await readAll(itx);
  return events.length ? (events[events.length - 1].offset as number) : 0;
};

// ── the two tables and the physical registry ──

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

// ── the idioms ──

/** Poll `fn` until it returns a truthy/defined value or time out. Absorbs transient throws (a call
 *  racing an eviction). */
export const until = async <T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
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

/** Await a promise that MUST reject promptly; hands back the error for inspection (its `code` is
 *  the machine-readable channel, lib/errors.ts). Throws if it fulfils, or is still pending at the
 *  deadline — a hang is a bug, never a wait. */
export async function rejection(
  p: Promise<unknown>,
  label = "the call",
  timeoutMs = 15_000,
): Promise<Error & { code?: string }> {
  const out = await Promise.race([
    p.then(
      (v) => ({ kind: "resolved" as const, v }),
      (e) => ({ kind: "rejected" as const, e }),
    ),
    sleep(timeoutMs).then(() => ({ kind: "hung" as const })),
  ]);
  if (out.kind === "hung")
    throw new Error(`${label}: still pending after ${timeoutMs}ms — expected a prompt rejection`);
  if (out.kind === "resolved")
    throw new Error(`${label}: resolved (${JSON.stringify(out.v)}) — expected a rejection`);
  return out.e as Error & { code?: string };
}

/** The machine-readable error channel (lib/errors.ts): classify by code, never by message. */
export const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;

/** A subscriber callback recording every delivery (deep-cloned — capnweb payloads must not be read
 *  after the callback's turn). Works verbatim as a push target and behind a cursor-lane hook. */
export function collector() {
  const invocations: { events: any[]; range: { after: number; through: number } }[] = [];
  return {
    fn: (events: any[], range: { after: number; through: number }) => {
      invocations.push(JSON.parse(JSON.stringify({ events, range })));
    },
    invocations,
    offsets: () => invocations.flatMap((i) => i.events.map((e) => e.offset as number)),
    types: () => invocations.flatMap((i) => i.events.map((e) => e.type as string)),
  };
}

/** One full eyeball WebSocket round trip: open → send → first message → close. Never throws — the
 *  caller asserts on the outcome. */
export function wsRoundTrip(
  url: string,
  send: string,
  timeoutMs = 10_000,
): Promise<{ opened: boolean; echo?: string; closeCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const out: { opened: boolean; echo?: string; closeCode?: number; error?: string } = {
      opened: false,
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      ws.send(send);
    });
    ws.addEventListener("message", (ev) => {
      out.echo = String((ev as MessageEvent).data);
      ws.close(1000, "done");
    });
    ws.addEventListener("error", (ev) => {
      out.error = String((ev as { message?: unknown }).message ?? "websocket error");
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      out.closeCode = (ev as CloseEvent).code;
      resolve(out);
    });
  });
}

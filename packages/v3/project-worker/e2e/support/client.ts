// e2e/support/client.ts — THE E2E client: open a capnweb session to the one shared worker (URL and
// admin secret from global-setup, via WORKER_BASE_URL and ADMIN_API_SECRET) for a FRESH ctx per test,
// exactly like a production client. This is the whole "how a test reaches the worker" surface, plus
// the handful of idioms every file used to copy (poll-until, must-reject, the delivery collector, the
// eyeball WebSocket round trip).

import { newWebSocketRpcSession } from "capnweb";
import type { SessionCredentials } from "../../src/session.ts";

const baseUrl = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

/** The worker's admin secret (global-setup: the local worker's, or a deployed run's ADMIN_API_SECRET). */
const adminApiSecret = (): string => {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error("ADMIN_API_SECRET unset — the e2e globalSetup/setup did not run");
  return secret;
};

/** THE lane's credentials (src/session.ts `SessionCredentials`): the admin secret — every project,
 *  `{ actor: "admin" }`; with `as`, that user's session (the projects of their orgs) — what a
 *  membership row authenticates with. */
export const adminCredentials = (as?: { sub: string; email: string }): SessionCredentials => ({
  type: "admin-secret",
  secret: adminApiSecret(),
  ...(as && { as }),
});

/** The same secret as a lane's bearer — what a raw request to `/expression` is admitted with. */
export const adminBearer = (): { authorization: string } => ({
  authorization: `Bearer ${adminApiSecret()}`,
});

/** A URL on the one shared worker — for the raw HTTP doors that have no itx method (/version, /demo). */
export const workerUrl = (path: string): string => new URL(path, baseUrl()).toString();

/** The plain-HTTP fetch lane: `/expression?context=<ctx>&itx=<itx expression>` (the worker copies the
 *  expression into `x-itx-expression` for the DO). */
export const expressionUrl = (
  ctx: string,
  itxExpression: string,
  scheme: "http" | "ws" = "http",
): string => {
  const u = new URL("/expression", baseUrl());
  u.protocol = `${scheme}:`;
  u.searchParams.set("context", ctx);
  u.searchParams.set("itx", itxExpression);
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

/** A raw capnweb session — an `UnauthenticatedSession` stub: `authenticate(adminCredentials())
 *  .projects.get(ctx)` is the itx. For flows that need the session itself (its identity, its
 *  `[Symbol.dispose]`). */
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

/** THE default door: a fresh session's itx for a project ctx (its root context), authenticated with
 *  the admin secret — any project, no directory row needed (src/session.ts); it is the only door —
 *  there is no bare one. */
export function openItx(ctx: string): any {
  return session().authenticate(adminCredentials()).projects.get(ctx);
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
  itx.invoke(["itx", ["append", ...events]]);

/** EVERY durable row of the log — paged on `scannedThroughOffset` until the page says it reached the
 *  head (a page is bounded by rows AND by bytes, so one page is not the log). */
export const readAll = async (itx: any): Promise<any[]> => {
  const all: any[] = [];
  for (let after = 0; ; ) {
    const page = await itx.invoke(["itx", ["readEvents", after, 500]]);
    all.push(...page.events);
    if (page.atHead === true || page.scannedThroughOffset <= after) return all;
    after = page.scannedThroughOffset;
  }
};

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
 *  physical built-in). Shrinks when a provider's session dies; a rewrite rule never does (it is
 *  pure data). */
export async function presence(itx: any): Promise<string[]> {
  return (await itx.rpcStubs.list()) as string[];
}

/** The matches of the LIVE rewrite rules — rules whose target names the `itx.builtins.rpcStubs` registry.
 *  Pure data: this set does NOT shrink when a provider dies; it shrinks when the rule is un-set. */
export async function rpcStubRewriteRuleMatches(itx: any): Promise<string[]> {
  return ((await itx.rewriteRules.list()) as { match: string; target: string | null }[])
    .filter(
      (rule) => rule.target !== null && /^itx\.(builtins\.)?rpcStubs\.get\(/.test(rule.target),
    ) // either spelling names the registry
    .map((rule) => rule.match);
}

/** Enabled processors = subscriptions that HOST a facet (M1 marks the row `hostedFacet`; the source
 *  is no longer in the target) and push its processEventBatch. */
export async function processorNames(itx: any): Promise<string[]> {
  return (await subscriptions(itx))
    .filter((s) => s.hostedFacet && /\.processEventBatch$/.test(s.target))
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
  let lastError: unknown;
  for (;;) {
    const v = await Promise.resolve(fn()).catch((error: unknown) => {
      lastError = error;
      return undefined;
    });
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(
        `until(${label}): timed out after ${timeoutMs}ms${lastError !== undefined ? ` — last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
      );
    await sleep(50);
  }
};

/** Await a promise that MUST reject promptly; hands back the error for inspection (its `code` is
 *  the machine-readable channel, lib.ts). Throws if it fulfils, or is still pending at the
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

/** The machine-readable error channel (lib.ts): classify by code, never by message. */
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
 *  caller asserts on the outcome. `headers` ride the handshake (node's WebSocket takes them; a
 *  browser's cannot) — the admin bearer a `/expression` upgrade is admitted with. */
export function wsRoundTrip(
  url: string,
  send: string,
  timeoutMs = 10_000,
  headers: Record<string, string> = {},
): Promise<{ opened: boolean; echo?: string; closeCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const out: { opened: boolean; echo?: string; closeCode?: number; error?: string } = {
      opened: false,
    };
    // node's WebSocket (undici) takes `{ headers }` as its second argument; @types/node types only
    // the protocols there
    const ws = new WebSocket(url, { headers } as never);
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

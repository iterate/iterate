// e2e/support/client.ts — THE E2E client: open a capnweb session to the one shared worker (URL and
// admin secret from global-setup, via WORKER_BASE_URL and ADMIN_API_SECRET) for a FRESH ctx per test,
// exactly like a production client. This is the whole "how a test reaches the worker" surface, plus
// the idioms the files share (poll-until, must-reject, the delivery collector).
// A project host — the one HTTP way into a project — is support/project-host.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket as UndiciWebSocket } from "undici";
import type { IterateRpcTarget, SessionCredentials } from "../../src/session.ts";

const baseUrl = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

/** The worker's admin bearer (global-setup: the local worker's, or a deployed worker's from its APP_CONFIG). */
const adminApiSecret = (): string => {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error("ADMIN_API_SECRET unset — the e2e globalSetup/setup did not run");
  return secret;
};

/** The worker's sign-in password (global-setup: the local worker's, or a deployed worker's from its
 *  APP_CONFIG) — `POST /login` with an email and this mints a browser session (support/principal.ts). */
export const loginPassword = (): string => {
  const password = process.env.LOGIN_PASSWORD;
  if (!password)
    throw new Error(
      "LOGIN_PASSWORD unset — the e2e globalSetup/setup did not run, or the deployment sets no login.password (prd)",
    );
  return password;
};

/** THE suite's credentials (src/session.ts `SessionCredentials`): the admin secret — every project,
 *  `{ actor: "admin" }`; with `as`, that user's session (the projects of their orgs) — what a
 *  membership row authenticates with. */
export const adminCredentials = (as?: {
  email: string;
}): Extract<SessionCredentials, { type: "admin-secret" }> => ({
  type: "admin-secret",
  secret: adminApiSecret(),
  as,
});

/** A URL on the one shared worker — for the raw HTTP routes that have no itx method (/version, /demo). */
export const workerUrl = (path: string): string => new URL(path, baseUrl()).toString();

/** MCP's protocol endpoint (global-setup: `<worker>/mcp`, or a deployed worker's own MCP origin). */
const mcpUrl = (): string => {
  const url = process.env.MCP_BASE_URL;
  if (!url) throw new Error("MCP_BASE_URL unset — the e2e globalSetup/setup did not run");
  return url;
};

let mcpRequestId = 0;
/** One MCP JSON-RPC call with `bearer`, answered as JSON or as an event stream; hands back the
 *  `result` and throws on a non-200 answer or a JSON-RPC `error`. */
export async function mcpCall(method: string, params: unknown, bearer: string): Promise<any> {
  const response = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpRequestId, method, params }),
  });
  const body = await response.text();
  if (response.status !== 200)
    throw new Error(`MCP ${method} answered ${response.status}: ${body}`);
  const message = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(
        body
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      )
    : JSON.parse(body);
  if (message.error) throw new Error(`MCP ${method} failed: ${body}`);
  return message.result;
}

/** THE RUN'S ID — one value for the whole `pnpm e2e` run, minted by global-setup and handed to every
 *  vitest worker process (support/setup.ts sets `E2E_RUN_ID` from it; a caller may pin it — a commit
 *  sha in CI). Every identifier a test mints carries it, so no two runs against one deployment can
 *  land on the same project, repo or account, however many run at once. */
let memoRunId = "";
export const runId = (): string =>
  // Hashed, not truncated: CI pins `<run id>-<attempt>`, and two consecutive GitHub run ids share
  // their leading digits — the first eight characters would name the same run twice.
  (memoRunId ||= crypto
    .createHash("sha1")
    .update(process.env.E2E_RUN_ID || crypto.randomUUID())
    .digest("hex")
    .slice(0, 8));

/** THIS vitest worker process, within the run. Files run in parallel in separate processes, each
 *  with its own `counter` starting at 0, so the slot is what keeps two processes' ids apart. */
export const workerSlot = (): string => process.env.VITEST_WORKER_ID || "0";

let repoCounter = 0;
/** A repo path unique to this run — one segment under `/e2e`, inside Artifacts' name grammar
 *  (`[a-zA-Z0-9._-]+`, never `--`). */
export const freshRepoPath = (prefix: string): string =>
  // Per run and per worker process, never random: a collision would delete a sibling's repo.
  `/e2e/${prefix}-${runId()}-${workerSlot()}-${repoCounter++}`;

let counter = 0;
/** A unique project ctx per call, so tests never collide on a Durable Object (each ctx is its own):
 *  `prj_<prefix>_<run>_<worker>_<n>` — unique across runs, across worker processes, and within one. */
export const freshCtx = (prefix: string): string =>
  `prj_${prefix}_${runId()}_${workerSlot()}_${counter++}`;

/** `/api` opened BARE (no credential on the upgrade): the socket authenticates in-band with the
 *  admin secret (src/api.ts, src/session.ts). */
const wsApi = (): string => {
  const u = new URL("/api", baseUrl());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
};

/** What one owner — a test, or the file around it — has open on the wire. */
type OpenTransports = { sessions: any[]; sockets: WebSocket[] };

/** THE SESSIONS TO DISPOSE belong to the RUNNING TEST, not to the module: the tests in one file run
 *  CONCURRENTLY (vitest.config.ts `sequence.concurrent`), so a module-level list would have the first
 *  test to finish close its siblings' live sessions. support/setup.ts opens a fresh store per test
 *  (`enterTestTransports` in `beforeEach` — vitest's runner carries the store into the test body and
 *  into that test's own `afterEach`) and disposes THAT store alone. */
const testTransports = new AsyncLocalStorage<OpenTransports>();
/** The fallback owner: whatever opens a session with no test running — a file's `beforeAll`, the
 *  benchmarks — disposed once per file (`disposeFileSessions`, support/setup.ts `afterAll`). */
const fileTransports: OpenTransports = { sessions: [], sockets: [] };
const openTransports = (): OpenTransports => testTransports.getStore() ?? fileTransports;

/** Own the sessions the current test opens — support/setup.ts calls this in `beforeEach`. */
export const enterTestTransports = (): void =>
  testTransports.enterWith({ sessions: [], sockets: [] });

/** A raw capnweb session — an `IterateRpcTarget` stub: `authenticate(adminCredentials())
 *  .projects.get(ctx)` is the itx. For flows that need the session itself (its identity, its
 *  `[Symbol.dispose]`). */
export function session(): any {
  const ws = new WebSocket(wsApi());
  explainSocketFailure(ws);
  const s = newWebSocketRpcSession(ws as any);
  openTransports().sessions.push(s);
  return s;
}

/** capnweb folds every lost socket into one "WebSocket connection failed." (its transport's `error`
 *  listener). This says which it was, beside the failure in the log: an upgrade the edge refused
 *  (undici fails the connection with "Received network error or non-101 status code.") or an open
 *  socket lost later, and when. Only an abnormal end fires `error` (undici fires it when no Close
 *  frame was received); a disposed session's clean close stays silent. */
function explainSocketFailure(ws: WebSocket) {
  const created = Date.now();
  let openedAfterMs: number | undefined;
  ws.addEventListener("open", () => (openedAfterMs = Date.now() - created), { once: true });
  ws.addEventListener(
    "error",
    (event) => {
      const cause = (event as ErrorEvent).error;
      console.warn({
        event: "e2e.websocket-failed",
        url: ws.url,
        openedAfterMs,
        failedAfterMs: Date.now() - created,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    },
    { once: true },
  );
}

/** A normal OAuth client supplies its bearer before the public WebSocket opens. */
export function publicSession(token: string) {
  const url = new URL(workerUrl("/api"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new UndiciWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const transport = newWebSocketRpcSession<IterateRpcTarget>(ws as unknown as WebSocket);
  const open = openTransports();
  open.sessions.push(transport);
  open.sockets.push(ws as unknown as WebSocket);
  return transport.authenticate({ type: "from-server-cookie" });
}

/** A capnweb session whose underlying WebSocket WE hold — so a test can sever the transport
 *  (network death, no capnweb goodbye) or instrument its frames: `prepare(ws)` runs BEFORE capnweb
 *  attaches, so a wrapped `send` / an early "message" listener sees every frame in wire order. */
export function rawSession(prepare?: (ws: WebSocket) => void): { session: any; ws: WebSocket } {
  const ws = new WebSocket(wsApi());
  const open = openTransports();
  open.sockets.push(ws);
  prepare?.(ws);
  const s = newWebSocketRpcSession(ws as any) as any;
  open.sessions.push(s);
  return { session: s, ws };
}

/** THE default entry point: a fresh session's itx for a project ctx (its root context), authenticated with
 *  the admin secret — any project, no catalog row needed (src/session.ts); it is the only way in —
 *  there is no bare one. */
export function openItx(ctx: string): any {
  return session().authenticate(adminCredentials()).projects.get(ctx);
}

function dispose(open: OpenTransports): void {
  for (const s of open.sessions.splice(0)) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
  for (const ws of open.sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Dispose every session (and close every raw socket) THIS TEST opened — wired to afterEach in
 *  support/setup.ts; a sibling test running at the same time keeps its own. */
export const disposeSessions = (): void => dispose(openTransports());

/** Dispose what the FILE opened outside any test (a `beforeAll`, the benchmarks) — afterEach never
 *  reaches those; support/setup.ts wires this to afterAll. */
export const disposeFileSessions = (): void => dispose(fileTransports);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the stream ──

/** A rewrite-rule event's `match` AT REST is the parsed prefix (the append boundary canonicalizes
 *  it the way it does the target); the keys these tests provide are plain dotted names, so joining
 *  the segments spells the key back. */
export const ruleMatchAtRest = (event: { payload?: { match?: unknown } }) => {
  const match = event.payload?.match;
  return Array.isArray(match) ? match.join(".") : "";
};

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

/** A log as its repo facts' short type names, in order (`repo/created`, …; a processor row's
 *  `stream/…` fact is not one). */
export const repoFactTypes = (log: { type: string }[]): string[] =>
  log
    .filter((e) => e.type.startsWith("events.iterate.com/repo"))
    .map((e) => e.type.replace("events.iterate.com/", ""));

/** What the `tally` fixture (support/sources.ts) has reduced so far. */
export const tallySnapshot = (itx: any): Promise<any> =>
  itx.invoke("itx.facets.get('tally').snapshot()");

/** What a "*" processor reduces: every durable event, each incarnation's `stream/woken` included
 *  (processor.ts `consumesEvent`). */
export const durableCountsByType = (events: any[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
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
 *  layer's read method: `[{ name, target, consumes?, configuredAtOffset, cursor?, halted? }]`. A
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
    .filter((rule) => rule.target && /^itx\.(builtins\.)?rpcStubs\.get\(/.test(rule.target)) // either spelling names the registry
    .map((rule) => rule.match);
}

/** Enabled processors = subscriptions that HOST a facet (the row is marked `hostedFacet`; the source
 *  is not in the target) and push its processEventBatch. */
export async function processorNames(itx: any): Promise<string[]> {
  return (await subscriptions(itx))
    .filter((s) => s.hostedFacet && /\.processEventBatch$/.test(s.target))
    .map((s) => s.name);
}

// ── the idioms ──

/** Poll `fn` until it returns a truthy/defined value or time out. Absorbs transient throws (a call
 *  racing an eviction). A timeout says how the wait went — how many polls answered, how many threw,
 *  and the slowest poll — so a worker that answered slowly (a queue ahead of the poll) reads
 *  differently from one that answered promptly and never had the state. */
export const until = async <T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> => {
  const t0 = Date.now();
  let lastError: unknown;
  let polls = 0;
  let threw = 0;
  let slowestPollMs = 0;
  for (;;) {
    const pollStarted = Date.now();
    const v = await Promise.resolve(fn()).catch((error: unknown) => {
      lastError = error;
      threw++;
      return undefined;
    });
    polls++;
    slowestPollMs = Math.max(slowestPollMs, Date.now() - pollStarted);
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(
        `until(${label}): timed out after ${timeoutMs}ms (${polls} polls, ${threw} threw, the slowest ${slowestPollMs}ms)${lastError !== undefined ? ` — last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
      );
    await sleep(50);
  }
};

/** Poll `read` until `done(value)` holds, and hand back that value. A timeout names the LAST VALUE
 *  READ — what the state was, not only that the wanted state never came (`until`'s message can only
 *  say the predicate stayed false) — as `describe` renders it (a log as its event types, say). */
export const untilValue = async <T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 20_000, describe = (value: T): unknown => value } = {},
): Promise<T> => {
  let last: { value: T } | undefined;
  try {
    return await until(
      label,
      async () => {
        const value = await read();
        last = { value };
        return done(value) ? { value } : false;
      },
      timeoutMs,
    ).then((hit) => hit.value);
  } catch (error) {
    if (!last) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — last value read: ${JSON.stringify(describe(last.value))?.slice(0, 2000)}`,
      { cause: error },
    );
  }
};

/** How many idles `idleAcrossEvictions` waits out. */
export const EVICTION_IDLES = 3;

/** Wake the context EVICTION_IDLES times with an idle gap between, then read its log — one
 *  `stream/woken` per incarnation. The platform evicts an idle actor in ~10 s (measured 2026-09-22:
 *  0/6 at 10 s, 48/48 at 12 s+), so each 12 s gap should cost one eviction. */
export async function idleAcrossEvictions(itx: any): Promise<any[]> {
  for (let i = 0; i < EVICTION_IDLES; i++) {
    await sleep(12_000);
    await itx.whoami();
  }
  return readAll(itx);
}

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

/** A subscriber callback recording every delivery (deep-cloned — capnweb payloads must not be read
 *  after the callback's turn). Works verbatim as a push target and behind a cursor-delivery hook. */
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

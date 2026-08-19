// itx-connection-directory.ts — THE ITX CONNECTION DIRECTORY: the domain layer over the
// hibernatable RPC stubs. The manager (core/hibernatable-rpc-stub.ts) knows sockets, pages and
// stubs; THIS class knows what a connection MEANS on the stream:
//
//   • IDENTITY: connectionId = String(connectedAtOffset) — the offset of the ephemeral
//     connection-opened fact. No synthetic ids; the log names every connection.
//   • THE SESSION RULE (crisp, timerless, storm-proof): two transports under one client-chosen
//     connectionKey belong to the same ItxConnectionSession unless separated by a CLEAN final
//     close or ≥ T of absence (T = 15 min). Decided at attach time from facts in hand: a
//     crash-loop reconnect storm is ONE session and ONE durable fact; a dirty death ends
//     nothing until superseded ("ended no later than…"). Durable connection-session-started/
//     -ended facts answer who-was-connected-Tuesday; ephemeral connection-opened/-closed facts
//     are the real-time notifications; `currentlyConnected()` is the runtime authority.
//     Anonymous attaches (no key — parked live callbacks) file no session history: their
//     durable trace is the capability mount that names them.
//   • THE VIEWS: invoke-by-key, each() fan-out, the currently connected clients, kick.
//
// Two-phase attach: the RPC mints the connectionId FIRST (it must append the opened fact to
// learn the offset), THEN the relay opens the stub pager WebSocket carrying it; an unknown id
// 409s so a relay that outlived a DO restart re-attaches. What a dead connection leaves behind
// (auto-revoking its mounts) is the composing DO's business — injected as `onFinalClose`.

import {
  HibernatableRpcStubManager,
  STUB_PAGER_WEBSOCKET_HEADER,
  type HibernatableRpcStubRecord,
  type RetainedCallbackInvoker,
} from "./core/hibernatable-rpc-stub.ts";
import type { StreamEvent, StreamEventInput } from "./core/events.ts";
import { codedError, reportIssue } from "./core/errors.ts";

/** The ItxConnectionSession record for one connectionKey (kv `connection-session:<key>`) — the
 *  session rule's working memory. The durable truth is the session facts on the stream; this
 *  record carries only what deciding the rule needs. */
type ItxConnectionSessionRecord = { sessionStartedAtOffset: number; lastActiveMs: number };
/** The session rule's T. */
const ITX_CONNECTION_SESSION_ABSENCE_MS = 15 * 60_000;

/** Everything the directory needs from its stream, injected — no hidden reach. */
type ItxConnectionDirectoryDeps = {
  hooks: {
    acceptWebSocket(ws: WebSocket, tags: string[]): void;
    getWebSockets(tag: string): WebSocket[];
  };
  kv: {
    get(key: string): unknown;
    put(key: string, value: unknown): void;
    delete(key: string): void;
  };
  /** Append connection facts to the stream (the directory's only writes besides its kv). */
  append(...facts: StreamEventInput[]): Promise<StreamEvent[]>;
  /** A connection died for good — the DO auto-revokes every mount targeting it. `keyFinal` ⇒
   *  no replacement transport carries the connectionKey either. */
  onFinalClose(input: {
    connectionId: string;
    connectionKey?: string;
    keyFinal: boolean;
  }): Promise<void>;
};

export class ItxConnectionDirectory {
  readonly #deps: ItxConnectionDirectoryDeps;
  readonly #stubs: HibernatableRpcStubManager;
  /** Records handed to `attach`, waiting for their stub pager WebSocket to arrive. In memory
   *  on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches. */
  readonly #pendingConnectionRecords = new Map<string, Record<string, unknown>>();

  constructor(deps: ItxConnectionDirectoryDeps) {
    this.#deps = deps;
    this.#stubs = new HibernatableRpcStubManager(deps.hooks);
  }

  // ── the lifecycle ──

  /** Attach an ItxConnection (the relay calls this BEFORE opening the stub pager WebSocket):
   *  the session rule, the durable session facts, the ephemeral connection-opened fact whose
   *  offset becomes the connectionId. */
  async attach(input: {
    connectionKey?: string;
    description?: string;
  }): Promise<{ connectionId: string; connectionKey?: string }> {
    let sessionStartedAtOffset: number | undefined;
    if (input.connectionKey) {
      // Reconnect under the same key replaces the predecessor transport (same logical client).
      for (const r of this.#stubs.all())
        if (r.connectionKey === input.connectionKey) this.#stubs.drop(r.stubKey, "replaced");
      const sessionKey = `connection-session:${input.connectionKey}`;
      const session = this.#deps.kv.get(sessionKey) as ItxConnectionSessionRecord | undefined;
      if (session && Date.now() - session.lastActiveMs < ITX_CONNECTION_SESSION_ABSENCE_MS) {
        sessionStartedAtOffset = session.sessionStartedAtOffset; // the same session continues
      } else {
        const facts: StreamEventInput[] = [];
        if (session)
          // A dirty death ended nothing at the time — settle it now, bounded by what we know.
          facts.push({
            type: "events.iterate.com/itx-connection/connection-session-ended",
            payload: {
              connectionKey: input.connectionKey,
              sessionStartedAtOffset: session.sessionStartedAtOffset,
              endedNoLaterThan: new Date(
                session.lastActiveMs + ITX_CONNECTION_SESSION_ABSENCE_MS,
              ).toISOString(),
            },
          });
        facts.push({
          type: "events.iterate.com/itx-connection/connection-session-started",
          payload: {
            connectionKey: input.connectionKey,
            ...(input.description ? { description: input.description } : {}),
          },
        });
        const committed = await this.#deps.append(...facts);
        sessionStartedAtOffset = committed[committed.length - 1].offset;
      }
      this.#deps.kv.put(sessionKey, {
        sessionStartedAtOffset,
        lastActiveMs: Date.now(),
      } satisfies ItxConnectionSessionRecord);
    }
    const [opened] = await this.#deps.append({
      type: "events.iterate.com/itx-connection/connection-opened",
      ephemeral: true,
      payload: {
        ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(sessionStartedAtOffset !== undefined ? { sessionStartedAtOffset } : {}),
      },
    });
    const connectionId = String(opened.offset);
    this.#pendingConnectionRecords.set(connectionId, {
      ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(sessionStartedAtOffset !== undefined ? { sessionStartedAtOffset } : {}),
      openedAt: new Date().toISOString(),
    });
    return {
      connectionId,
      ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
    };
  }

  /** PARTIAL FETCH (compose first in the DO's fetch): the stub pager upgrade, gated on a
   *  pending attach record. `undefined` = not this door's request. */
  fetch(request: Request): Response | undefined {
    const pagingConnectionId = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    if (pagingConnectionId === null) return undefined;
    const record = this.#pendingConnectionRecords.get(pagingConnectionId);
    if (!record)
      return new Response(`unknown itx connection ${pagingConnectionId} (attach first)\n`, {
        status: 409,
      });
    const response = this.#stubs.fetch(request)!;
    if (response.status === 101) {
      this.#pendingConnectionRecords.delete(pagingConnectionId);
      this.#stubs.attach(pagingConnectionId, record);
    }
    return response;
  }

  /** The page answer: a fresh RetainedCallbackInvoker stub, kept warm until the quiesce. */
  activate(input: { connectionId: string; invoker: RetainedCallbackInvoker }) {
    return this.#stubs.activate({ stubKey: input.connectionId, invoker: input.invoker });
  }

  drop(connectionId: string, reason: string): void {
    this.#stubs.drop(connectionId, reason);
  }

  /** A pager WebSocket closed (wire this to webSocketClose/webSocketError): the ephemeral
   *  connection-closed fact; for keyed connections whose close was CLEAN and final, the durable
   *  session end; then the DO's onFinalClose (auto-revoke). Fire-and-forget safe. */
  closed(ws: WebSocket, code: number, reason: string): void {
    const record = this.#stubs.closed(ws);
    if (record)
      void this.#connectionClosed(record, code, reason).catch((e) =>
        reportIssue("itx-connections.close", e, { connectionId: record.stubKey }),
      );
  }

  async #connectionClosed(
    record: HibernatableRpcStubRecord,
    code: number,
    reason: string,
  ): Promise<void> {
    const connectionId = record.stubKey; // the stub key IS the connectionId (connectedAtOffset)
    const connectionKey = record.connectionKey as string | undefined;
    // "replaced" is the SAME logical connection changing transports — never a key-final close.
    const keyFinal =
      typeof connectionKey === "string" &&
      reason !== "replaced" &&
      !this.#stubs
        .all()
        .some((r) => r.connectionKey === connectionKey && r.stubKey !== connectionId);
    const facts: StreamEventInput[] = [
      {
        type: "events.iterate.com/itx-connection/connection-closed",
        ephemeral: true,
        payload: {
          connectionId,
          ...(connectionKey !== undefined ? { connectionKey } : {}),
          code,
          reason,
        },
      },
    ];
    if (keyFinal) {
      const sessionKey = `connection-session:${connectionKey}`;
      const session = this.#deps.kv.get(sessionKey) as ItxConnectionSessionRecord | undefined;
      if (session) {
        if (code === 1000) {
          // A clean, final end closes the session NOW — the next attach starts a fresh one.
          facts.push({
            type: "events.iterate.com/itx-connection/connection-session-ended",
            payload: { connectionKey, sessionStartedAtOffset: session.sessionStartedAtOffset },
          });
          this.#deps.kv.delete(sessionKey);
        } else {
          // A dirty death ends nothing yet — stamp the absence clock; the next attach (or ≥T of
          // absence) settles it ("ended no later than…").
          this.#deps.kv.put(sessionKey, {
            ...session,
            lastActiveMs: Date.now(),
          } satisfies ItxConnectionSessionRecord);
        }
      }
    }
    await this.#deps.append(...facts);
    await this.#deps.onFinalClose({ connectionId, connectionKey, keyFinal });
  }

  // ── the views + the delivery legs ──

  find(key: string): HibernatableRpcStubRecord | undefined {
    return this.#stubs.all().find((r) => r.connectionKey === key || r.stubKey === key);
  }

  /** Invoke one connection's retained callback by connectionKey/connectionId. */
  invoke(key: string, segments: string[], args: unknown[]): Promise<unknown> {
    const record = this.find(key);
    if (!record) throw codedError("CONNECTION_OFFLINE", `itx connection "${key}" is offline`);
    return this.#stubs.invoke(record.stubKey, segments, args);
  }

  /** The delivery leg: by stubKey directly (the caller already held the record). */
  invokeConnection(stubKey: string, path: string[], args: unknown[]): Promise<unknown> {
    return this.#stubs.invoke(stubKey, path, args);
  }

  /** Fan out one dotted method call over EVERY connection attached to this context
   *  (allSettled — a dead connection drops out of the results). */
  async fanOut(method: string[], args: unknown[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(
      this.#stubs.all().map((r) => this.#stubs.invoke(r.stubKey, method, args)),
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  /** The currently connected clients of this context. */
  currentlyConnected(): Record<string, unknown>[] {
    return this.#stubs.all().map((r) => ({
      connectionId: r.stubKey,
      ...(r.connectionKey !== undefined ? { connectionKey: r.connectionKey } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.openedAt !== undefined ? { openedAt: r.openedAt } : {}),
    }));
  }

  /** Kick a connection by connectionKey/connectionId (idempotent — unknown keys are a no-op). */
  close(key: string): { ok: true } {
    const record = this.find(key);
    if (record) this.#stubs.drop(record.stubKey, "kicked");
    return { ok: true };
  }

  /** The idle quiesce (paged-in stubs pin the DO; a page gets them back). */
  disposeRetainedStubs(): void {
    this.#stubs.disposeRetainedStubs();
  }

  state(): Record<string, unknown> {
    return this.#stubs.state();
  }
}

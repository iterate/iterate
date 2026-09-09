// library/capnweb.ts — `itx.connectToCapnweb(url, { headers?, transport? })`: a remote capnweb API's
// main object as a pipelinable handle, written against `itx.fetch` alone (the library rule, index.ts).
// The WebSocket is opened THROUGH egress — `itx.fetch` with the Upgrade header, the 101's socket
// accepted and handed to capnweb — so `{{secret:project:NAME}}` headers substitute and the socket is
// the context's. `{ transport: "batch" }` is the one-shot alternative: capnweb's HTTP batch client
// uses the global fetch, so the same transport is re-spelled here over `itx.fetch` (RpcTransport is
// capnweb's own extension point for exactly that). A held connection pins this context awake for its
// life, like a busy facet; dispose it and the session closes. A batch connection holds no socket:
// each chain is its own batch session, so it never pins anything.

import { RpcSession, newWebSocketRpcSession, type RpcStub, type RpcTransport } from "capnweb";
import { InvokeHandle, walkStepsOnRpcStub } from "../context/invoke-handle.ts";
import { refuseUnlessOk, responseRefusal, type LibraryItx } from "./index.ts";

/** The remote main object: unknown by construction — the caller's dotted calls are its contract. */
type RemoteMain = RpcStub<any>;

/** Options for `connectToCapnweb`: headers for the handshake (auth), and the transport — a WebSocket
 *  session (default) or one HTTP batch per call chain. */
export type CapnwebConnectOptions = {
  headers?: Record<string, string>;
  transport?: "websocket" | "batch";
};

/** Connect and hand back the remote main object as a handle. A WebSocket session is opened now and
 *  shared by every later call; the batch transport opens one capnweb batch session PER CHAIN (a
 *  batch is one POST and dies with it — capnweb's own contract), which is the one-shot shape. */
export async function connectToCapnweb(
  itx: LibraryItx,
  url: string,
  options: CapnwebConnectOptions = {},
): Promise<CapnwebConnection> {
  const headers = options.headers ?? {};
  if (options.transport === "batch")
    return new CapnwebConnection(
      () => batchSessionOverEgress(itx, url, headers),
      () => undefined,
    );
  // The WebSocket session is opened NOW (a connect that cannot reach the far side fails here) and
  // REOPENED on the next call after it is gone — disposed (the context's idle quiesce releases every
  // library connection, index.ts) or broken by the far side — so a held or memoized connection is
  // never a dead socket.
  type SessionStub = RemoteMain & { onRpcBroken?: (cb: () => void) => void };
  let session: SessionStub | undefined;
  /** ONE reopen in flight at a time: concurrent calls after the session is gone share it (each
   *  opening its own would leak every socket but the last one assigned). */
  let reopening: Promise<SessionStub> | undefined;
  /** Bumped by close: a reopen that lands after a close disposes what it opened instead of reviving. */
  let generation = 0;
  const dispose = (stub: SessionStub | undefined) =>
    (stub as unknown as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  const open = async (): Promise<SessionStub> => {
    const stub = (await webSocketSessionOverEgress(itx, url, headers)) as SessionStub;
    stub.onRpcBroken?.(() => {
      if (session === stub) session = undefined;
    });
    return stub;
  };
  const reopen = async (): Promise<SessionStub> => {
    const startedIn = generation;
    try {
      const opened = await open();
      if (startedIn !== generation) {
        dispose(opened);
        throw new Error("capnweb connection closed while it was reconnecting");
      }
      session = opened;
      return opened;
    } finally {
      reopening = undefined;
    }
  };
  session = await open();
  return new CapnwebConnection(
    () => session ?? (reopening ??= reopen()),
    () => {
      generation += 1;
      const gone = session;
      session = undefined;
      dispose(gone);
    },
  );
}

/** A remote capnweb API held across calls: an InvokeHandle, so `conn.a.b(x)` reduces into one dispatch
 *  that walks the capnweb stub step by step — capnweb pipelines property access and calls, so the
 *  chain is one round trip (one WebSocket exchange, or exactly one batch POST). Disposing closes the
 *  WebSocket session (the next call reopens it); a batch connection holds nothing. */
export class CapnwebConnection extends InvokeHandle {
  readonly #closeSession: () => void;
  /** `remoteMain` answers the stub SYNCHRONOUSLY while a session is open — the walk then queues the
   *  whole chain before any batch fires or any await yields — and a promise only while a session is
   *  being (re)opened. */
  constructor(remoteMain: () => RemoteMain | Promise<RemoteMain>, closeSession: () => void) {
    super((steps) => {
      const main = remoteMain();
      return main instanceof Promise
        ? main.then((stub) => walkStepsOnRpcStub(stub, steps))
        : walkStepsOnRpcStub(main, steps);
    });
    this.#closeSession = closeSession;
  }
  /** Close the WebSocket session (the next call reopens it); a batch connection holds nothing. A
   *  DECLARED member on purpose: the dotted fallback beneath `InvokeHandle` answers every unknown
   *  name with a REMOTE path, so a probe for `close` (`releaseConnections`, index.ts) must find this
   *  one — else it would call `close()` on the remote main and leave the local socket open. */
  close(): void {
    this.#closeSession();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

async function webSocketSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): Promise<RemoteMain> {
  const httpUrl = url.replace(/^ws(s?):/i, "http$1:");
  const response = await itx.fetch(
    new Request(httpUrl, { headers: { ...headers, upgrade: "websocket" } }),
  );
  const webSocket = response.webSocket;
  if (response.status !== 101 || !webSocket)
    throw await responseRefusal(response, `connectToCapnweb: ${url} (no WebSocket)`);
  webSocket.accept();
  return newWebSocketRpcSession(webSocket as unknown as WebSocket);
}

function batchSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): RemoteMain {
  const transport = new EgressBatchTransport(async (batch) => {
    const response = await itx.fetch(
      new Request(url, { method: "POST", headers, body: batch.join("\n") }),
    );
    await refuseUnlessOk(response, `connectToCapnweb: batch to ${url}`);
    const text = await response.text();
    return text === "" ? [] : text.split("\n");
  });
  return new RpcSession(transport).getRemoteMain();
}

/** capnweb's own HTTP batch client transport, over an injected send: every message sent before the
 *  microtask queue drains rides in ONE POST; the answers are received back in order. */
class EgressBatchTransport implements RpcTransport {
  #messagesToSend: string[] | null = [];
  #abortReason: unknown;
  /** The one POST's answers, in order — settled once the macrotask after construction has run. */
  readonly #answersReceived: Promise<string[]>;
  constructor(sendBatch: (batch: string[]) => Promise<string[]>) {
    this.#answersReceived = (async () => {
      // one macrotask, so every `.then()` on the pipelined promises registers before the batch goes
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.#abortReason !== undefined) throw this.#abortReason;
      const batch = this.#messagesToSend!;
      this.#messagesToSend = null;
      return sendBatch(batch);
    })();
  }
  async send(message: string): Promise<void> {
    if (this.#messagesToSend !== null) this.#messagesToSend.push(message);
  }
  async receive(): Promise<string> {
    const received = await this.#answersReceived;
    const message = received.shift();
    if (message === undefined) throw new Error("Batch RPC request ended.");
    return message;
  }
  abort(reason: unknown): void {
    this.#abortReason = reason;
  }
}

// `/api` is the one untrusted capnweb boundary. Capnweb's receiver limits raw string length before
// JSON.parse, but JSON.parse itself can materialize millions of tiny arrays before the later ITX
// admission gate sees an invoke. These transports reject that wire shape while it is still text.
import {
  newHttpBatchRpcResponse,
  RpcSession,
  WebSocketTransport,
  type RpcTransport,
} from "capnweb";

/** Match Capnweb's default per-message ceiling; this is not a new smaller payload policy. */
export const RPC_MAX_MESSAGE_CODE_UNITS = 32 * 1024 * 1024;
/** The aggregate is bounded even when a batch contains many individually valid messages. */
export const RPC_MAX_HTTP_BATCH_BYTES = 32 * 1024 * 1024;
// A refusal may briefly finish an ordinary in-flight upload so its client receives the coded
// response, but it must never turn an abusive chunked upload into unbounded background work.
const RPC_REFUSAL_DRAIN_TIMEOUT_MS = 250;

// These are deliberately a decoded-shape budget, not a raw-byte budget. A six-megabyte document
// string has one container and passes; a much smaller `[[ ], [ ], …]` frame reaches this limit.
// A structural token has a modest wire representation but may materialize an independent JS
// container/member during JSON.parse. Keep the estimated decoded bookkeeping under 32 MiB; this
// is intentionally not a smaller general payload ceiling (large document strings have no tokens).
const RPC_MAX_STRUCTURAL_BYTES = 32 * 1024 * 1024;
const CONTAINER_BYTES = 24;
const MEMBER_BYTES = 12;
const MAX_NESTING = 256;

export type RpcAdmissionKind = "MESSAGE_TOO_LARGE" | "MESSAGE_TOO_COMPLEX";

export class RpcAdmissionError extends Error {
  readonly code = "RPC_ADMISSION_REJECTED";
  readonly retryable = false;

  constructor(readonly kind: RpcAdmissionKind) {
    super(`RPC_ADMISSION_REJECTED:${kind}`);
  }
}

/** Incremental, quote/escape-aware structural accounting. It intentionally leaves JSON validity
 * to Capnweb's normal JSON.parse; its only job is to bound allocation before that parse exists. */
class RpcMessageAdmissionScanner {
  #codeUnits = 0;
  #structuralBytes = 0;
  #depth = 0;
  #inString = false;
  #escaped = false;

  write(chunk: string): void {
    for (let i = 0; i < chunk.length; i += 1) this.#writeCodeUnit(chunk[i]);
  }

  reset(): void {
    this.#codeUnits = 0;
    this.#structuralBytes = 0;
    this.#depth = 0;
    this.#inString = false;
    this.#escaped = false;
  }

  #writeCodeUnit(character: string): void {
    this.#codeUnits += 1;
    if (this.#codeUnits > RPC_MAX_MESSAGE_CODE_UNITS)
      throw new RpcAdmissionError("MESSAGE_TOO_LARGE");

    if (this.#inString) {
      if (this.#escaped) this.#escaped = false;
      else if (character === "\\") this.#escaped = true;
      else if (character === '"') this.#inString = false;
      return;
    }

    if (character === '"') {
      this.#inString = true;
      return;
    }
    if (character === "[" || character === "{") {
      this.#depth += 1;
      if (this.#depth > MAX_NESTING) throw new RpcAdmissionError("MESSAGE_TOO_COMPLEX");
      this.charge(CONTAINER_BYTES);
      return;
    }
    if (character === "]" || character === "}") {
      if (this.#depth > 0) this.#depth -= 1;
      return;
    }
    if (character === "," || character === ":") this.charge(MEMBER_BYTES);
  }

  private charge(bytes: number): void {
    this.#structuralBytes += bytes;
    if (this.#structuralBytes > RPC_MAX_STRUCTURAL_BYTES)
      throw new RpcAdmissionError("MESSAGE_TOO_COMPLEX");
  }
}

export function assertAdmittedRpcMessage(message: string): void {
  new RpcMessageAdmissionScanner().write(message);
}

/** A guarded Workers stream performs aggregate-byte and per-line frame admission before the
 * official helper can finish `request.text()` and reach its JSON.parse. Newlines delimit HTTP
 * batch frames; raw newlines cannot be part of a valid JSON string. */
function admittedHttpRequest(request: Request): Request {
  if (!request.body) return request;
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > RPC_MAX_HTTP_BATCH_BYTES)
    throw new RpcAdmissionError("MESSAGE_TOO_LARGE");

  let receivedBytes = 0;
  // Match Request.text(): malformed UTF-8 is replacement-decoded and remains Capnweb's normal
  // JSON-validity concern rather than becoming a new admission category.
  const decoder = new TextDecoder();
  const scanner = new RpcMessageAdmissionScanner();
  const scan = (text: string) => {
    let start = 0;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
      scanner.write(text.slice(start, index));
      scanner.reset();
      start = index + 1;
    }
    scanner.write(text.slice(start));
  };
  const reader = request.body.getReader();
  const drain = async (refusal: RpcAdmissionError) => {
    const deadline = Date.now() + RPC_REFUSAL_DRAIN_TIMEOUT_MS;
    let drainedBytes = 0;
    const drainBudget = Math.max(0, RPC_MAX_HTTP_BATCH_BYTES - receivedBytes);
    try {
      while (drainedBytes < drainBudget) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        let timeout: number | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(resolve, remainingMs);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!next || next.done) break;
        drainedBytes += next.value.byteLength;
      }
    } finally {
      // This ends a malicious/infinite upload after its bounded grace window. Cancellation is
      // deliberately secondary: a remote request body's cancellation can wait for its peer, so
      // never let it postpone the original admission response.
      void reader.cancel(refusal).catch(() => {
        // A peer may already have closed while the refusal was being returned.
      });
    }
  };
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        try {
          scan(decoder.decode());
          controller.close();
        } catch (error) {
          controller.error(error);
        }
        return;
      }
      const chunk = next.value;
      receivedBytes += chunk.byteLength;
      try {
        if (receivedBytes > RPC_MAX_HTTP_BATCH_BYTES)
          throw new RpcAdmissionError("MESSAGE_TOO_LARGE");
        scan(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      } catch (error) {
        if (error instanceof RpcAdmissionError) await drain(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Request(request, { body: guarded });
}

/** Wrap Capnweb's native WebSocket transport rather than reimplementing its socket lifecycle.
 * `receive()` yields the raw string before RpcSession parses it, so refusal retains Capnweb's
 * standard abort frame and terminal close behavior. */
class AdmittedWebSocketTransport implements RpcTransport {
  readonly #transport: WebSocketTransport;

  constructor(socket: WebSocket) {
    this.#transport = new WebSocketTransport(socket);
  }

  send(message: string): void {
    this.#transport.send(message);
  }

  async receive(): Promise<string> {
    const message = await this.#transport.receive();
    assertAdmittedRpcMessage(message);
    return message;
  }

  abort(reason: unknown): void {
    this.#transport.abort(reason);
  }
}

/** The one `/api` admission entrypoint. Normal accepted frames still use Capnweb's own session,
 * decoding, batch draining, and response protocol unchanged. */
export async function newAdmittedWorkersRpcResponse(
  request: Request,
  localMain: unknown,
): Promise<Response> {
  if (request.method === "POST") {
    try {
      const response = await newHttpBatchRpcResponse(admittedHttpRequest(request), localMain);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    } catch (error) {
      if (error instanceof RpcAdmissionError)
        return Response.json({ code: error.code, kind: error.kind }, { status: 413 });
      throw error;
    }
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });

  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  // Match Capnweb's WebSocket helper exactly: creating the bootstrap import roots the session.
  new RpcSession(new AdmittedWebSocketTransport(server), localMain).getRemoteMain();
  return new Response(null, { status: 101, webSocket: pair[1] });
}

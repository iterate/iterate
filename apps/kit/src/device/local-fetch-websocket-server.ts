import { STATUS_CODES, createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from "ws";

const selectedProtocol = Symbol("iterate-kit-selected-websocket-protocol");
const defaultMaximumBufferedBytes = 8 * 640;
const maximumControlMessageTraceEntries = 64;
const maximumControlMessageTraceParseBytes = 8 * 1024;
const maximumHttpBodyBytes = 1024 * 1024;

interface UpgradeRequest extends IncomingMessage {
  [selectedProtocol]?: string;
}

interface FetchHandler {
  fetch(request: Request): Response | Promise<Response>;
}

export interface LocalFetchWebSocketServerOptions extends FetchHandler {
  host: string;
  maximumBufferedBytes?: number;
  onBridgeClosed?: (metrics: LocalFetchWebSocketBridgeMetrics) => void;
  port?: number;
}

/**
 * Fixed-size evidence from one device-facing TCP WebSocket generation.
 *
 * These values deliberately describe the extra LAN adapter layer, not the
 * Workers-shaped peer behind it. Retaining one record per PCM frame would make
 * the diagnostic harness itself an endurance-memory leak, so the bridge keeps
 * only counts, maxima, and the terminal cause.
 */
export interface LocalFetchWebSocketBridgeMetrics {
  closeCode: number;
  closeReason: string;
  controlMessageTrace: LocalFetchWebSocketControlMessageTraceEntry[];
  deviceSocketCloseDisposition: "alreadyClosed" | "tcpReset" | "webSocketClose";
  /*
   * `bufferedAmount` is useful runtime evidence but includes WebSocket frame
   * bytes. Payload-in-flight is the media-age bound: eight 640-byte payloads
   * mean 160 ms of speech regardless of how `ws` encoded their headers.
   */
  deviceSocketMaximumBufferedBytes: number;
  deviceSocketMaximumPayloadBytesInFlight: number;
  deviceSocketMaximumSendCallbackLatencyMs: number;
  deviceSocketMaximumSendCallbacksInFlight: number;
  /*
   * A completed callback latency cannot describe sends still pending at the
   * moment of failure. The oldest age closes that observability hole without
   * retaining one timestamp per high-rate frame.
   */
  deviceSocketOldestSendCallbackAgeMsAtClose: number;
  deviceSocketPayloadBytesInFlightAtClose: number;
  deviceSocketSendCallbacksInFlightAtClose: number;
  deviceToWorkerBytes: number;
  deviceToWorkerMessages: number;
  elapsedMs: number;
  endpoint: string;
  maximumBufferedBytes: number;
  protocol: string;
  workerToDeviceBytes: number;
  workerToDeviceMaximumInterarrivalMs: number;
  workerToDeviceMessages: number;
}

export interface LocalFetchWebSocketControlMessageTraceEntry {
  command: "abort" | "binary" | "invalid" | "pull" | "push" | "reject" | "release" | "resolve";
  direction: "deviceToWorker" | "workerToDevice";
  elapsedMs: number;
  id: number | null;
  method: string;
  payloadBytes: number;
}

/**
 * Hosts a Workers-shaped fetch/WebSocket implementation on a real LAN socket.
 *
 * The physical harness needs two transport fixtures with different jobs:
 * Captun deliberately exercises Internet/reconnect adversity, while this
 * adapter removes the tunnel from strict device/audio timing. It does not
 * reinterpret requests or reimplement the Kit peer. Instead it asks the same
 * fetch handler for its Response, extracts Captun's Workers-compatible
 * `webSocket`, and immediately bridges that endpoint to one TCP WebSocket.
 *
 * There is no application message queue. Each binary payload is copied once
 * at the runtime boundary because both the Kit proxy and `ws` are allowed to
 * reuse caller-owned buffers after `send()` returns. The bridge accounts
 * payload bytes until each `ws.send()` callback finishes and refuses the
 * message that would exceed the configured allowance. `bufferedAmount` is
 * retained as wire/runtime evidence, but cannot enforce a media budget because
 * it also includes variable WebSocket framing.
 */
export class LocalFetchWebSocketServer {
  readonly #fetch: FetchHandler["fetch"];
  readonly #httpServer;
  readonly #maximumBufferedBytes: number;
  readonly #onBridgeClosed: LocalFetchWebSocketServerOptions["onBridgeClosed"];
  readonly #sockets = new Set<NodeWebSocket>();
  readonly #webSocketServer: WebSocketServer;
  readonly baseUrl: string;
  readonly webSocketOrigin: string;
  #closePromise: Promise<void> | undefined;

  private constructor(options: {
    baseUrl: string;
    fetch: FetchHandler["fetch"];
    httpServer: ReturnType<typeof createServer>;
    maximumBufferedBytes: number;
    onBridgeClosed: LocalFetchWebSocketServerOptions["onBridgeClosed"];
    webSocketServer: WebSocketServer;
  }) {
    this.baseUrl = options.baseUrl;
    this.webSocketOrigin = options.baseUrl.replace(/^http/u, "ws");
    this.#fetch = options.fetch;
    this.#httpServer = options.httpServer;
    this.#maximumBufferedBytes = options.maximumBufferedBytes;
    this.#onBridgeClosed = options.onBridgeClosed;
    this.#webSocketServer = options.webSocketServer;
  }

  static async listen(options: LocalFetchWebSocketServerOptions) {
    const maximumBufferedBytes = options.maximumBufferedBytes ?? defaultMaximumBufferedBytes;
    if (!Number.isSafeInteger(maximumBufferedBytes) || maximumBufferedBytes < 640) {
      throw new Error("The local WebSocket buffer allowance must hold at least one PCM frame.");
    }
    const webSocketServer = new WebSocketServer({
      handleProtocols(_offered, request) {
        /*
         * `ws` otherwise selects the first offered protocol. On the PCM socket
         * that could echo the bearer-token carrier instead of
         * `iterate.kit.pcm.v1`; on control it could claim a protocol the fetch
         * implementation never selected. The fetch Response remains the one
         * authority for handshake negotiation.
         */
        return (request as UpgradeRequest)[selectedProtocol] ?? false;
      },
      noServer: true,
    });
    let localServer: LocalFetchWebSocketServer | undefined;
    const httpServer = createServer((request, response) => {
      if (!localServer) {
        response.statusCode = 503;
        response.end("Local fetch server is starting.");
        return;
      }
      void localServer.#handleHttp(request).then(
        async (fetchResponse) => {
          response.statusCode = fetchResponse.status;
          for (const [name, value] of fetchResponse.headers) {
            response.setHeader(name, value);
          }
          response.end(Buffer.from(await fetchResponse.arrayBuffer()));
        },
        (error) => {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : "Local fetch failed.");
        },
      );
    });
    const listening = Promise.withResolvers<void>();
    httpServer.once("error", listening.reject);
    httpServer.listen(options.port ?? 0, options.host, listening.resolve);
    await listening.promise;
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      httpServer.close();
      throw new Error("The local WebSocket server did not expose a TCP address.");
    }
    const host = options.host.includes(":") ? `[${options.host}]` : options.host;
    localServer = new LocalFetchWebSocketServer({
      baseUrl: `http://${host}:${address.port}`,
      fetch: options.fetch,
      httpServer,
      maximumBufferedBytes,
      onBridgeClosed: options.onBridgeClosed,
      webSocketServer,
    });
    httpServer.on("upgrade", (request, socket, head) => {
      if (localServer) void localServer.#handleUpgrade(request, socket, head);
    });
    return localServer;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = new Promise<void>((resolve) => {
      for (const socket of this.#sockets) socket.close(1000, "Local device harness stopped.");
      this.#sockets.clear();
      this.#httpServer.close(() => resolve());
      this.#httpServer.closeIdleConnections();
    });
    return this.#closePromise;
  }

  async #handleHttp(request: IncomingMessage) {
    const fetchRequest = await this.#requestFromNode(request);
    return this.#fetch(fetchRequest);
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => {});
    try {
      const fetchRequest = await this.#requestFromNode(request);
      const response = await this.#fetch(fetchRequest);
      /*
       * Cloudflare's Response type has a nonstandard `webSocket` member on a
       * 101 upgrade. Captun installs the same member on Node's Response
       * fallback, but TypeScript's platform-neutral lib cannot express it.
       * This cast only reveals that optional runtime field; absence is checked
       * before any upgrade is accepted.
       */
      const workerSocket = (response as Response & { webSocket?: WebSocket }).webSocket;
      if (!workerSocket) {
        await this.#rejectUpgrade(socket, response);
        return;
      }
      const protocol = response.headers.get("sec-websocket-protocol");
      if (protocol) (request as UpgradeRequest)[selectedProtocol] = protocol;
      /*
       * This listener belongs to `node:http.createServer`, not an HTTPS or
       * user-supplied server. Node therefore creates the upgrade stream as a
       * net.Socket even though @types/node exposes the more general Duplex
       * listener contract. Retain that concrete socket: only
       * `resetAndDestroy()` promises a TCP RST that discards kernel-accepted
       * stale speech. WebSocket.terminate() merely calls destroy().
       */
      const tcpSocket = socket as Socket;
      tcpSocket.setNoDelay(true);
      this.#webSocketServer.handleUpgrade(request, socket, head, (nodeSocket) => {
        this.#bridge(
          nodeSocket,
          tcpSocket,
          workerSocket,
          new URL(request.url ?? "/", this.baseUrl).pathname,
          protocol ?? "",
        );
      });
    } catch (error) {
      const response = new Response(error instanceof Error ? error.message : "Upgrade failed.", {
        status: 500,
      });
      await this.#rejectUpgrade(socket, response);
    }
  }

  #bridge(
    nodeSocket: NodeWebSocket,
    tcpSocket: Socket,
    workerSocket: WebSocket,
    endpoint: string,
    protocol: string,
  ) {
    nodeSocket.binaryType = "arraybuffer";
    this.#sockets.add(nodeSocket);
    let closed = false;
    const startedAt = performance.now();
    let deviceSocketMaximumBufferedBytes = 0;
    let deviceSocketMaximumPayloadBytesInFlight = 0;
    let deviceSocketMaximumSendCallbackLatencyMs = 0;
    let deviceSocketMaximumSendCallbacksInFlight = 0;
    let deviceSocketOldestSendStartedAt: number | undefined;
    let deviceSocketPayloadBytesInFlight = 0;
    let deviceSocketSendCallbacksInFlight = 0;
    let deviceToWorkerBytes = 0;
    let deviceToWorkerMessages = 0;
    let lastWorkerToDeviceMessageAt: number | undefined;
    const controlMessageTrace: LocalFetchWebSocketControlMessageTraceEntry[] = [];
    let workerToDeviceBytes = 0;
    let workerToDeviceMaximumInterarrivalMs = 0;
    let workerToDeviceMessages = 0;
    const closeBoth = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      this.#sockets.delete(nodeSocket);
      const deviceSocketCloseDisposition = closeNodeSocket(nodeSocket, tcpSocket, code, reason);
      closeWorkerSocket(workerSocket, code, reason);
      this.#onBridgeClosed?.({
        closeCode: code,
        closeReason: reason,
        controlMessageTrace: [...controlMessageTrace],
        deviceSocketCloseDisposition,
        deviceSocketMaximumBufferedBytes,
        deviceSocketMaximumPayloadBytesInFlight,
        deviceSocketMaximumSendCallbackLatencyMs,
        deviceSocketMaximumSendCallbacksInFlight,
        deviceSocketOldestSendCallbackAgeMsAtClose:
          deviceSocketOldestSendStartedAt === undefined
            ? 0
            : performance.now() - deviceSocketOldestSendStartedAt,
        deviceSocketPayloadBytesInFlightAtClose: deviceSocketPayloadBytesInFlight,
        deviceSocketSendCallbacksInFlightAtClose: deviceSocketSendCallbacksInFlight,
        deviceToWorkerBytes,
        deviceToWorkerMessages,
        elapsedMs: performance.now() - startedAt,
        endpoint,
        maximumBufferedBytes: this.#maximumBufferedBytes,
        protocol,
        workerToDeviceBytes,
        workerToDeviceMaximumInterarrivalMs,
        workerToDeviceMessages,
      });
    };
    nodeSocket.on("message", (data, isBinary) => {
      if (closed) return;
      try {
        const payload = isBinary ? copyRawData(data) : rawDataText(data);
        const payloadBytes =
          typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
        deviceToWorkerMessages += 1;
        deviceToWorkerBytes += payloadBytes;
        recordControlMessageTrace({
          direction: "deviceToWorker",
          elapsedMs: performance.now() - startedAt,
          endpoint,
          payload,
          payloadBytes,
          trace: controlMessageTrace,
        });
        workerSocket.send(payload);
      } catch {
        closeBoth(1011, "LAN bridge receive failed.");
      }
    });
    nodeSocket.once("close", (code, reason) => {
      closeBoth(code, reason.toString());
    });
    nodeSocket.once("error", () => {
      closeBoth(1011, "LAN WebSocket failed.");
    });
    workerSocket.addEventListener("message", (event) => {
      if (closed) return;
      const messageReceivedAt = performance.now();
      if (lastWorkerToDeviceMessageAt !== undefined) {
        workerToDeviceMaximumInterarrivalMs = Math.max(
          workerToDeviceMaximumInterarrivalMs,
          messageReceivedAt - lastWorkerToDeviceMessageAt,
        );
      }
      lastWorkerToDeviceMessageAt = messageReceivedAt;
      deviceSocketMaximumBufferedBytes = Math.max(
        deviceSocketMaximumBufferedBytes,
        nodeSocket.bufferedAmount,
      );
      try {
        let payload: string | Uint8Array;
        if (typeof event.data === "string") {
          payload = event.data;
        } else {
          const bytes = synchronousBinaryCopy(event.data);
          if (!bytes) {
            closeBoth(4002, "LAN bridge received unsupported binary data.");
            return;
          }
          payload = bytes;
        }
        const payloadBytes =
          typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
        recordControlMessageTrace({
          direction: "workerToDevice",
          elapsedMs: messageReceivedAt - startedAt,
          endpoint,
          payload,
          payloadBytes,
          trace: controlMessageTrace,
        });
        /*
         * Check the next payload, not `ws.bufferedAmount` from the preceding
         * frame. The old comparison stopped a physical run at 5,152 bytes:
         * eight 640-byte payloads plus eight four-byte headers. That close
         * happened at a meaningful 160 ms media backlog, but its aggregate
         * made the incident look like a 32-byte off-by-one. Payload accounting
         * expresses the actual freshness invariant and rejects the ninth frame
         * before it can enter another opaque queue.
         */
        if (payloadBytes > this.#maximumBufferedBytes - deviceSocketPayloadBytesInFlight) {
          closeBoth(4013, "LAN bridge backpressure.");
          return;
        }
        workerToDeviceMessages += 1;
        workerToDeviceBytes += payloadBytes;
        const sendStartedAt = performance.now();
        if (deviceSocketSendCallbacksInFlight === 0) {
          deviceSocketOldestSendStartedAt = sendStartedAt;
        }
        deviceSocketPayloadBytesInFlight += payloadBytes;
        deviceSocketMaximumPayloadBytesInFlight = Math.max(
          deviceSocketMaximumPayloadBytesInFlight,
          deviceSocketPayloadBytesInFlight,
        );
        deviceSocketSendCallbacksInFlight += 1;
        deviceSocketMaximumSendCallbacksInFlight = Math.max(
          deviceSocketMaximumSendCallbacksInFlight,
          deviceSocketSendCallbacksInFlight,
        );
        let sendFinished = false;
        const finishSend = (error?: Error) => {
          /*
           * `ws.send()` normally completes asynchronously, but it may throw
           * before accepting a frame if lifecycle state changes between our
           * message check and this call. Release the exact same ledger in both
           * paths; otherwise a synchronous failure would be reported as media
           * retained by a socket that never owned it.
           */
          if (sendFinished) return;
          sendFinished = true;
          deviceSocketPayloadBytesInFlight -= payloadBytes;
          deviceSocketSendCallbacksInFlight -= 1;
          if (deviceSocketSendCallbacksInFlight === 0) {
            deviceSocketOldestSendStartedAt = undefined;
          }
          deviceSocketMaximumSendCallbackLatencyMs = Math.max(
            deviceSocketMaximumSendCallbackLatencyMs,
            performance.now() - sendStartedAt,
          );
          if (error) closeBoth(1011, "LAN bridge send failed.");
        };
        try {
          nodeSocket.send(payload, { binary: typeof payload !== "string" }, finishSend);
        } catch (error) {
          finishSend();
          throw error;
        }
        /*
         * `ws.bufferedAmount` is the bytes still retained by its Sender plus
         * Node's writable stream, not the kernel's complete TCP history. Read
         * it immediately after send as well as before the next frame so a
         * single large jump remains visible even if close races the next
         * provider event.
         */
        deviceSocketMaximumBufferedBytes = Math.max(
          deviceSocketMaximumBufferedBytes,
          nodeSocket.bufferedAmount,
        );
      } catch {
        closeBoth(1011, "LAN bridge send failed.");
      }
    });
    workerSocket.addEventListener(
      "close",
      (event) => {
        closeBoth(event.code, event.reason);
      },
      { once: true },
    );
    workerSocket.addEventListener(
      "error",
      () => {
        closeBoth(1011, "Workers-style WebSocket failed.");
      },
      { once: true },
    );
    /*
     * Captun's in-process WebSocketPair queues events until the selected side
     * is accepted. Install every bridge listener first, then release that
     * queue so an eager deterministic provider cannot lose its first frame.
     */
    const acceptingSocket = workerSocket as WebSocket & { accept?: () => void };
    acceptingSocket.accept?.();
  }

  async #requestFromNode(request: IncomingMessage) {
    const headers = new Headers();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
    }
    const method = request.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBoundedHttpBody(request, maximumHttpBodyBytes);
    return new Request(new URL(request.url ?? "/", this.baseUrl), {
      body,
      headers,
      method,
    });
  }

  async #rejectUpgrade(socket: Duplex, response: Response) {
    const body = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.set("connection", "close");
    headers.set("content-length", String(body.byteLength));
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/plain; charset=utf-8");
    }
    const reason = STATUS_CODES[response.status] ?? "WebSocket Rejected";
    const lines = [`HTTP/1.1 ${response.status} ${reason}`];
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    lines.push("", "");
    socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
  }
}

function recordControlMessageTrace(options: {
  direction: LocalFetchWebSocketControlMessageTraceEntry["direction"];
  elapsedMs: number;
  endpoint: string;
  payload: string | Uint8Array;
  payloadBytes: number;
  trace: LocalFetchWebSocketControlMessageTraceEntry[];
}) {
  /*
   * This chronology diagnoses only the low-rate Cap'n Web control lane. JSON
   * parsing every PCM frame would make the observer compete with the realtime
   * path it is intended to explain.
   *
   * Never retain an envelope or its arguments. Project credentials and method
   * arguments are legal Cap'n Web values. The fixed entry count bounds
   * endurance memory, the parse-size ceiling bounds transient diagnostic work,
   * and command/method allow-lists prevent arbitrary strings from becoming an
   * accidental secret log. Sixty-four terminal envelopes cover several full
   * push/pull/resolve/release exchanges while keeping the failure evidence
   * small enough to print atomically.
   */
  if (options.endpoint !== "/api") return;
  const metadata = summarizeControlMessage(options.payload, options.payloadBytes);
  if (options.trace.length === maximumControlMessageTraceEntries) options.trace.shift();
  options.trace.push({
    ...metadata,
    direction: options.direction,
    elapsedMs: options.elapsedMs,
    payloadBytes: options.payloadBytes,
  });
}

function summarizeControlMessage(
  payload: string | Uint8Array,
  payloadBytes: number,
): Pick<LocalFetchWebSocketControlMessageTraceEntry, "command" | "id" | "method"> {
  if (typeof payload !== "string") {
    return { command: "binary", id: null, method: "" };
  }
  if (payloadBytes > maximumControlMessageTraceParseBytes) {
    return { command: "invalid", id: null, method: "" };
  }
  try {
    const message: unknown = JSON.parse(payload);
    if (!Array.isArray(message)) return { command: "invalid", id: null, method: "" };
    const rawCommand = message[0];
    if (!isControlCommand(rawCommand)) {
      return { command: "invalid", id: null, method: "" };
    }
    const id =
      rawCommand !== "push" && Number.isSafeInteger(message[1]) ? (message[1] as number) : null;
    return {
      command: rawCommand,
      id,
      method: rawCommand === "push" ? safePushedMethod(message[1]) : "",
    };
  } catch {
    return { command: "invalid", id: null, method: "" };
  }
}

function isControlCommand(
  value: unknown,
): value is Exclude<LocalFetchWebSocketControlMessageTraceEntry["command"], "binary" | "invalid"> {
  return (
    value === "abort" ||
    value === "pull" ||
    value === "push" ||
    value === "reject" ||
    value === "release" ||
    value === "resolve"
  );
}

function safePushedMethod(expression: unknown) {
  if (!Array.isArray(expression) || expression[0] !== "pipeline") return "";
  const path = expression[2];
  if (!Array.isArray(path) || path.length === 0) return "";
  const method = path.at(-1);
  /*
   * Method names are useful causal metadata, but they are still peer input.
   * Restrict them to the identifier vocabulary used by Kit capabilities so a
   * deliberately unusual property name cannot smuggle an argument or token
   * into durable diagnostics.
   */
  return typeof method === "string" && /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/u.test(method)
    ? method
    : "";
}

async function readBoundedHttpBody(request: IncomingMessage, maximumBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumBytes) {
      throw new Error(`Local HTTP request exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function synchronousBinaryCopy(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return undefined;
}

function copyRawData(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

function rawDataText(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function closeNodeSocket(socket: NodeWebSocket, tcpSocket: Socket, code: number, reason: string) {
  /*
   * 4013 means the realtime media freshness bound was crossed. A graceful
   * WebSocket close would sit behind any PCM already accepted by the kernel,
   * allowing seconds of obsolete conversation to reach the device after the
   * path recovers. TCP reset is deliberately less polite: its product
   * contract is that this connection generation, including opaque kernel
   * backlog, becomes undeliverable before a fresh generation can start.
   */
  if (code === 4013) {
    if (tcpSocket.destroyed) return "alreadyClosed";
    tcpSocket.resetAndDestroy();
    return "tcpReset";
  }
  if (socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) {
    return "alreadyClosed";
  }
  if (code === 1000 || (code >= 3000 && code <= 4999)) {
    socket.close(code, reason);
  } else {
    socket.close();
  }
  return "webSocketClose";
}

function closeWorkerSocket(socket: WebSocket, code: number, reason: string) {
  try {
    if (code === 1000 || (code >= 3000 && code <= 4999)) {
      socket.close(code, reason);
    } else {
      socket.close();
    }
  } catch {
    // Both endpoints are already terminal; close is best-effort cleanup only.
  }
}

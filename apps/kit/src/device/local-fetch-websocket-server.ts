import { STATUS_CODES, createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from "ws";

const selectedProtocol = Symbol("iterate-kit-selected-websocket-protocol");
const defaultMaximumBufferedBytes = 8 * 640;
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
  port?: number;
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
 * reuse caller-owned buffers after `send()` returns. If the runtime's own
 * bounded `bufferedAmount` exceeds the configured allowance, both endpoints
 * are closed rather than retaining stale speech.
 */
export class LocalFetchWebSocketServer {
  readonly #fetch: FetchHandler["fetch"];
  readonly #httpServer;
  readonly #maximumBufferedBytes: number;
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
    webSocketServer: WebSocketServer;
  }) {
    this.baseUrl = options.baseUrl;
    this.webSocketOrigin = options.baseUrl.replace(/^http/u, "ws");
    this.#fetch = options.fetch;
    this.#httpServer = options.httpServer;
    this.#maximumBufferedBytes = options.maximumBufferedBytes;
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
       * Node types the upgrade stream as the generic Duplex contract even
       * though the HTTP server supplies a net.Socket. Disable Nagle when that
       * concrete capability is present; a runtime without it remains correct
       * and is simply unable to offer the low-latency optimization.
       */
      if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true);
      }
      this.#webSocketServer.handleUpgrade(request, socket, head, (nodeSocket) => {
        this.#bridge(nodeSocket, workerSocket);
      });
    } catch (error) {
      const response = new Response(error instanceof Error ? error.message : "Upgrade failed.", {
        status: 500,
      });
      await this.#rejectUpgrade(socket, response);
    }
  }

  #bridge(nodeSocket: NodeWebSocket, workerSocket: WebSocket) {
    nodeSocket.binaryType = "arraybuffer";
    this.#sockets.add(nodeSocket);
    let closed = false;
    const closeBoth = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      this.#sockets.delete(nodeSocket);
      closeNodeSocket(nodeSocket, code, reason);
      closeWorkerSocket(workerSocket, code, reason);
    };
    nodeSocket.on("message", (data, isBinary) => {
      if (closed) return;
      try {
        workerSocket.send(isBinary ? copyRawData(data) : rawDataText(data));
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
      if (nodeSocket.bufferedAmount > this.#maximumBufferedBytes) {
        closeBoth(4013, "LAN bridge backpressure.");
        return;
      }
      try {
        if (typeof event.data === "string") {
          nodeSocket.send(event.data);
          return;
        }
        const bytes = synchronousBinaryCopy(event.data);
        if (!bytes) {
          closeBoth(4002, "LAN bridge received unsupported binary data.");
          return;
        }
        nodeSocket.send(bytes, { binary: true });
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

function closeNodeSocket(socket: NodeWebSocket, code: number, reason: string) {
  if (socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) return;
  if (code === 1000 || (code >= 3000 && code <= 4999)) {
    socket.close(code, reason);
  } else {
    socket.close();
  }
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

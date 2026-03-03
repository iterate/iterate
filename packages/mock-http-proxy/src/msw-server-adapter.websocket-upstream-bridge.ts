import type http from "node:http";
import type tls from "node:tls";
import {
  WebSocket,
  type RawData as WsRawData,
  type WebSocket as WsSocket,
  type WebSocketServer,
} from "ws";

export type WebSocketBridgeCloseBehavior = {
  code?: number;
  reason?: string;
};

export type BridgeWebSocketToUpstreamOptions = {
  req: http.IncomingMessage;
  socket: tls.TLSSocket;
  head: Buffer;
  targetUrl: URL;
  upgradeServer: WebSocketServer;
  excludeRequestHeaderNames?: Iterable<string>;
  closeClientOnUpstreamError?: WebSocketBridgeCloseBehavior;
  closeUpstreamOnClientError?: WebSocketBridgeCloseBehavior;
  onUpstreamUpgrade?: (response: http.IncomingMessage) => void;
  onClientMessage?: (data: WsRawData, isBinary: boolean) => void;
  onUpstreamMessage?: (data: WsRawData, isBinary: boolean) => void;
  onClientError?: () => void;
  onUpstreamError?: () => void;
  onFinalize?: () => void;
};

export function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function parseWebSocketProtocols(headerValue: string): string | Array<string> | undefined {
  if (!headerValue) return undefined;
  const protocols = headerValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (protocols.length === 0) return undefined;
  if (protocols.length === 1) return protocols[0];
  return protocols;
}

export function buildUpstreamWebSocketHeaders(
  req: http.IncomingMessage,
  options: { excludeNames?: Iterable<string> } = {},
): Record<string, string> {
  const excluded = new Set([
    "host",
    "connection",
    "upgrade",
    "proxy-connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    ...(options.excludeNames ?? []),
  ]);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (excluded.has(name)) continue;
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function closeSocketIfOpen(socket: WsSocket, behavior: WebSocketBridgeCloseBehavior = {}): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  socket.close(behavior.code, behavior.reason);
}

export function bridgeWebSocketToUpstream(options: BridgeWebSocketToUpstreamOptions): void {
  options.upgradeServer.handleUpgrade(options.req, options.socket, options.head, (clientSocket) => {
    const upstreamHeaders = buildUpstreamWebSocketHeaders(options.req, {
      excludeNames: options.excludeRequestHeaderNames,
    });
    const protocols = parseWebSocketProtocols(
      firstHeaderValue(options.req.headers["sec-websocket-protocol"]),
    );
    const upstream =
      protocols === undefined
        ? new WebSocket(options.targetUrl.toString(), { headers: upstreamHeaders })
        : new WebSocket(options.targetUrl.toString(), protocols, { headers: upstreamHeaders });

    const queuedClientMessages: Array<{ data: WsRawData; isBinary: boolean }> = [];
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      options.onFinalize?.();
    };

    upstream.on("upgrade", (response) => {
      options.onUpstreamUpgrade?.(response);
    });

    clientSocket.on("message", (data, isBinary) => {
      options.onClientMessage?.(data, isBinary);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      queuedClientMessages.push({ data, isBinary });
    });

    upstream.on("open", () => {
      for (const queued of queuedClientMessages) {
        upstream.send(queued.data, { binary: queued.isBinary });
      }
      queuedClientMessages.length = 0;
    });

    upstream.on("message", (data, isBinary) => {
      options.onUpstreamMessage?.(data, isBinary);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });

    clientSocket.on("close", () => {
      closeSocketIfOpen(upstream);
      finalize();
    });

    upstream.on("close", () => {
      closeSocketIfOpen(clientSocket);
      finalize();
    });

    clientSocket.on("error", () => {
      options.onClientError?.();
      closeSocketIfOpen(upstream, options.closeUpstreamOnClientError);
      finalize();
    });

    upstream.on("error", () => {
      options.onUpstreamError?.();
      closeSocketIfOpen(clientSocket, options.closeClientOnUpstreamError);
      finalize();
    });
  });
}

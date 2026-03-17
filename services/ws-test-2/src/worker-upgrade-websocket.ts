import { WSContext, defineWebSocketHelper } from "hono/ws";
type WorkerUpgradeOptions = {
  protocol?: string;
};

function parseRequestedProtocols(headerValue: string | undefined) {
  if (!headerValue) return [];

  return headerValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const upgradeWebSocket = defineWebSocketHelper<WebSocket, WorkerUpgradeOptions>(
  async (c, events, options) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return;
    }

    const requestedProtocols = parseRequestedProtocols(c.req.header("Sec-WebSocket-Protocol"));
    const selectedProtocol = options?.protocol;

    if (selectedProtocol && !requestedProtocols.includes(selectedProtocol)) {
      return new Response(`Expected Sec-WebSocket-Protocol: ${selectedProtocol}`, {
        status: 400,
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const wsContext = new WSContext({
      close: (code, reason) => server.close(code, reason),
      protocol: selectedProtocol ?? server.protocol,
      raw: server,
      get readyState() {
        return server.readyState as 0 | 1 | 2 | 3;
      },
      url: server.url ? new URL(server.url) : null,
      send: (source) => server.send(source),
    });

    if (events.onClose) {
      server.addEventListener("close", (event) => {
        events.onClose?.(event, wsContext);
      });
    }

    if (events.onMessage) {
      server.addEventListener("message", (event) => {
        events.onMessage?.(event, wsContext);
      });
    }

    if (events.onError) {
      server.addEventListener("error", (event) => {
        events.onError?.(event, wsContext);
      });
    }

    server.accept();

    const headers = new Headers();
    if (selectedProtocol) {
      headers.set("Sec-WebSocket-Protocol", selectedProtocol);
    }

    return new Response(null, {
      headers,
      status: 101,
      webSocket: client,
    });
  },
);

export type WorkerUpgradeWebSocket = typeof upgradeWebSocket;

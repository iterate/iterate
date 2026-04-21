/**
 * Opens an outbound websocket to `callbackUrl` (subscriber-configured). No custom headers:
 * the subscriber URL is opaque, and compatibility with agent runtimes that emit their own
 * JSON on the same connection is handled in `external-subscriber.ts` by ignoring frames that
 * are not stream-socket append/error payloads.
 */
export async function openOutboundWebSocket(callbackUrl: string) {
  const websocketKey = createWebSocketKey();
  const response = (await fetch(getWebsocketUpgradeFetchUrl(callbackUrl).toString(), {
    headers: {
      Connection: "Upgrade",
      "Sec-WebSocket-Key": websocketKey,
      "Sec-WebSocket-Version": "13",
      Upgrade: "websocket",
    },
  })) as Response & { webSocket?: WebSocket | null };

  const socket = response.webSocket;
  if (socket == null) {
    throw new Error(`Subscriber did not accept websocket upgrade. Status: ${response.status}`);
  }

  socket.accept();
  return socket;
}

function createWebSocketKey() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = Array.from(randomBytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

function getWebsocketUpgradeFetchUrl(callbackUrl: string) {
  const url = new URL(callbackUrl);

  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return url;
}

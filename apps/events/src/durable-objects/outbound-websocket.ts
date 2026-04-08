export async function openOutboundWebSocket(callbackUrl: string) {
  const response = (await fetch(getWebsocketUpgradeFetchUrl(callbackUrl).toString(), {
    headers: {
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

function getWebsocketUpgradeFetchUrl(callbackUrl: string) {
  const url = new URL(callbackUrl);

  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return url;
}

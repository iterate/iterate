type WebSocketReadyTarget = {
  readyState: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

/** Native browser WebSockets reject send() while CONNECTING. Cap'n Web can
 * pipeline RPC calls once attached, but authentication must start only after
 * the transport itself reaches OPEN. */
export function waitForWebSocketOpen(socket: WebSocketReadyTarget): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  if (socket.readyState > 1) {
    return Promise.reject(new Error("WebSocket closed before opening"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket failed before opening"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

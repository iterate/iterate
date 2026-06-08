export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close", cb: () => void, options?: unknown): void;
  addEventListener(type: "error", cb: (event?: unknown) => void, options?: unknown): void;
  addEventListener(
    type: "message",
    cb: (event: { data: unknown }) => void,
    options?: unknown,
  ): void;
}

export type SocketOpener = (url: string) => WebSocketLike | Promise<WebSocketLike>;

export const globalWebSocket: SocketOpener = (url) => {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (!WebSocketCtor) {
    throw new Error("[capnweb] no global WebSocket; pass `open: fromWs(WS)`");
  }
  return new WebSocketCtor(url);
};

export const fromWs =
  (WebSocketCtor: new (url: string) => WebSocketLike): SocketOpener =>
  (url) =>
    new WebSocketCtor(url);

export const workersFetchWith =
  (fetcher: typeof fetch): SocketOpener =>
  async (url) => {
    const response = await fetcher(url.replace(/^ws/i, "http"), {
      headers: { Upgrade: "websocket" },
    });
    const webSocket = (response as unknown as { webSocket?: WebSocketLike & { accept(): void } })
      .webSocket;
    if (!webSocket) {
      throw new Error(`[capnweb] no websocket upgrade from ${url} (${response.status})`);
    }
    webSocket.accept();
    return webSocket;
  };

export const workersFetch = workersFetchWith(fetch);

/**
 * Marker response for WebSocket upgrades.
 * Route handlers return this; the server entry detects it and
 * handles the upgrade with crossws + WebSocketPair.
 *
 * Same pattern as NitroWebSocketResponse from @iterate-com/shared,
 * but without the Nitro dependency.
 */
export interface Peer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketHooks {
  open?(peer: Peer): void | Promise<void>;
  message?(
    peer: Peer,
    message: { rawData: unknown; uint8Array(): Uint8Array },
  ): void | Promise<void>;
  close?(peer: Peer): void;
  error?(peer: Peer): void;
}

export class WebSocketResponse extends Response {
  wsHooks: WebSocketHooks;

  constructor(hooks: WebSocketHooks) {
    super("WebSocket upgrade required", { status: 426 });
    this.wsHooks = hooks;
  }
}

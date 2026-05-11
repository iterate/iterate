import type { WebSocketHooks } from "nitro/h3";

/**
 * This is an exclusive nitro + crossws behavior.
 * If you put a crossws property on a response, nitro will automatically pick that up and handle the websocket connection for you.
 * See: https://github.com/nitrojs/nitro/blob/5d51b7f3f9f0ecf6c201f71b6a48aa7d2c1dd025/src/runtime/internal/app.ts#L78-L82
 *
 * This is a lightweight wrapper around the Response class for easier usage and type safety.
 */
export class NitroWebSocketResponse extends Response {
  crossws: Partial<WebSocketHooks> = {};

  constructor(hooks: Partial<WebSocketHooks>) {
    super("WebSocket upgrade is required.", { status: 426 });
    this.crossws = hooks;
  }
}

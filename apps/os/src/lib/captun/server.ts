import { acceptCaptunTunnelFromSocket } from "./server-core.ts";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.ts";

export type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.ts";
export { acceptCaptunTunnelFromSocket } from "./server-core.ts";

/** Creates a Worker WebSocket upgrade response and matching tunnel handle. */
export function acceptCaptunTunnel(options: CaptunServerAcceptTunnelOptions = {}): {
  tunnel: CaptunServerTunnel;
  response: Response;
} {
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  serverSocket.accept();

  // Diagnostic: log any unhandled errors on the server socket to identify
  // the source of scriptThrewException in Cloudflare DO analytics.
  serverSocket.addEventListener("error", (event) => {
    console.error("[captun] server WebSocket error event:", event);
  });
  serverSocket.addEventListener("close", (event) => {
    console.log("[captun] server WebSocket close event:", event.code, event.reason);
  });

  const tunnel = acceptCaptunTunnelFromSocket(serverSocket, options);
  return {
    tunnel,
    response: new Response(null, { status: 101, webSocket: clientSocket }),
  };
}

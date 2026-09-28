/**
 * The pet shop's WebSocket gateways: the shop's access token on a socket rather than on an HTTP
 * request, the credential shapes an OS secret must reach beyond an Authorization header. Two shapes,
 * the same token (oauth-provider.ts), presented two ways:
 *
 *   - `/gateway`          the Discord shape: the token inside the IDENTIFY frame, after the socket
 *                         opens, so a secret sends it itself (`x-itx-secret-frames`).
 *   - `/gateway-header`   the OpenAI-Realtime shape: `Authorization: Bearer` on the UPGRADE, where
 *                         the OS substitutes a `getSecret(...)` placeholder like any header.
 *
 * Protocol (JSON text frames, Discord's op names):
 *   on connect                       {"op":"hello","heartbeatIntervalMs":30000}
 *   a valid token                    {"op":"ready","user":{sub,clientId}} then one
 *                                    {"op":"dispatch","type":"pet.created",...}
 *   a missing, invalid or dead one   {"op":"invalid","reason":"..."} and close(4001)
 *   any frame after ready            {"op":"echo","received":<frame>}
 *
 * The heartbeat is advertised, never enforced.
 */
import { petshopOauth } from "./oauth-provider.ts";
import type { ShopDeps } from "./state.ts";

/** Discord's close code for a failed IDENTIFY, for any auth failure here. */
const AUTH_FAILED_CLOSE_CODE = 4001;

/** `GET /gateway` or `GET /gateway-header`: a 101 with the socket, or a 426 for a plain request;
 *  null for any other path. */
export async function handleGatewayRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" || (pathname !== "/gateway" && pathname !== "/gateway-header"))
    return null;
  if (request.headers.get("Upgrade") !== "websocket")
    return Response.json(
      { error: "upgrade_required", error_description: `GET ${pathname} is a websocket` },
      { status: 426 },
    );
  const pair = new WebSocketPair();
  const socket = pair[1];
  socket.accept();
  socket.send(JSON.stringify({ op: "hello", heartbeatIntervalMs: 30_000 }));
  let identified = false;
  /** `ready` for a token live at its client's current epoch; else `invalid` and the close. */
  const identify = async (token: unknown) => {
    const access =
      typeof token === "string" ? await petshopOauth(deps).openAccessToken(token) : null;
    if (!access) {
      socket.send(JSON.stringify({ op: "invalid", reason: "missing, invalid, or expired token" }));
      return socket.close(AUTH_FAILED_CLOSE_CODE, "authentication failed");
    }
    identified = true;
    socket.send(
      JSON.stringify({ op: "ready", user: { sub: access.grant.sub, clientId: access.clientId } }),
    );
    socket.send(
      JSON.stringify({
        op: "dispatch",
        type: "pet.created",
        data: { id: "pet-3", name: "Rex", species: "terrier" },
      }),
    );
  };
  // The header shape authenticates at the upgrade alone: a failed one gets no frame loop, so a
  // racing IDENTIFY frame cannot authenticate instead.
  if (pathname === "/gateway-header") {
    await identify(/^bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim());
    if (!identified) return new Response(null, { status: 101, webSocket: pair[0] });
  }
  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    if (identified) return socket.send(JSON.stringify({ op: "echo", received: raw }));
    const frame = parsedFrame(raw);
    if (frame?.op !== "identify") {
      socket.send(
        JSON.stringify({ op: "invalid", reason: "first frame must be an identify frame" }),
      );
      return socket.close(AUTH_FAILED_CLOSE_CODE, "authentication failed");
    }
    identify(frame.token).catch(() =>
      socket.close(AUTH_FAILED_CLOSE_CODE, "authentication failed"),
    );
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function parsedFrame(raw: string): { op?: unknown; token?: unknown } | null {
  try {
    return JSON.parse(raw) as { op?: unknown; token?: unknown } | null;
  } catch {
    return null;
  }
}

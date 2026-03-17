import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterClient } from "@orpc/server";
import { registryContract } from "@iterate-com/registry-contract";
import type { Router } from "@/server/router.ts";

function createAbsoluteClient(): RouterClient<Router> {
  const link = new OpenAPILink(registryContract, {
    url: `${location.origin}/api`,
  });
  return createORPCClient(link);
}

let cachedClient: ReturnType<typeof createAbsoluteClient> | undefined;

export function getStreamsClient() {
  cachedClient ??= createAbsoluteClient();
  return cachedClient;
}

export function createStreamsWebSocketClient(): RouterClient<Router> {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/orpc/ws`, ["orpc"]);
  const link = new WebSocketRPCLink({ websocket: ws });
  return createORPCClient(link) as RouterClient<Router>;
}

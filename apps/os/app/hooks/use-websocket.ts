import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { useParams } from "react-router";
import { WebSocket as PartySocket } from "partysocket";

// Re-export event types from backend
const InvalidateInfo = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ALL"),
  }),
  z.object({
    type: z.literal("QUERY_KEY"),
    queryKeys: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal("TRPC_QUERY"),
    paths: z.array(z.string()),
  }),
]);

const PushControllerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("INVALIDATE"),
    invalidateInfo: InvalidateInfo,
  }),
  z.object({
    type: z.literal("NOTIFICATION"),
    notificationType: z.enum(["success", "error", "info", "warning"]),
    message: z.string(),
    extraToastArgs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("CUSTOM"),
    payload: z.unknown(),
  }),
]);

type PushControllerEvent = z.infer<typeof PushControllerEvent>;

function tryParseJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function matchPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Simple pattern matching - could be enhanced
    if (pattern.endsWith("*")) {
      return path.startsWith(pattern.slice(0, -1));
    }
    return path === pattern;
  });
}

export function useOrganizationWebSocket() {
  const queryClient = useQueryClient();
  const params = useParams();
  const organizationId = params.organizationId;
  const estateId = params.estateId;

  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<PartySocket | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Build the WebSocket URL
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const wsUrl =
    organizationId && estateId
      ? `${protocol}//${host}/api/ws/${organizationId}?estateId=${estateId}&organizationId=${organizationId}`
      : null;

  useEffect(() => {
    if (!wsUrl) {
      console.warn("Cannot connect WebSocket: missing organizationId or estateId");
      return;
    }

    console.log("Creating PartySocket connection:", wsUrl);

    // Create PartySocket with auto-reconnection
    const ws = new PartySocket(wsUrl, [], {
      debug: true, // Enable debug mode for development
      maxReconnectionDelay: 10000,
      minReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1.3,
      connectionTimeout: 4000,
      maxRetries: Infinity, // Keep trying to reconnect
      minUptime: 5000, // Consider connection stable after 5 seconds
    });

    wsRef.current = ws;

    // Setup event handlers
    ws.addEventListener("open", () => {
      console.log("PartySocket connected");
      setIsConnected(true);

      // Setup ping interval for keepalive
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === PartySocket.OPEN) {
          ws.send("ping");
        }
      }, 30000); // Ping every 30 seconds
    });

    ws.addEventListener("message", (event) => {
      // Handle pong (keepalive)
      if (event.data === "pong") {
        return;
      }

      // Handle other messages
      if (typeof event.data === "string") {
        const maybeJson = tryParseJson(event.data);
        if (!maybeJson) {
          return;
        }

        // Handle connection confirmation
        if (maybeJson.type === "CONNECTED") {
          console.log("WebSocket connection confirmed:", maybeJson);
          return;
        }

        // Handle echo messages (for debugging)
        if (maybeJson.type === "ECHO") {
          console.log("Echo received:", maybeJson);
          return;
        }

        // Handle push controller events
        const parsed = PushControllerEvent.safeParse(maybeJson);
        if (!parsed.success) {
          console.warn("Invalid WebSocket message:", maybeJson);
          return;
        }

        const payload = parsed.data;

        if (payload.type === "INVALIDATE") {
          const { invalidateInfo } = payload;

          if (invalidateInfo.type === "ALL") {
            console.log("Invalidating all queries");
            queryClient.invalidateQueries();
          } else if (invalidateInfo.type === "QUERY_KEY") {
            console.log("Invalidating queries by key:", invalidateInfo.queryKeys);
            queryClient.invalidateQueries({
              queryKey: invalidateInfo.queryKeys,
              exact: false,
            });
          } else if (invalidateInfo.type === "TRPC_QUERY") {
            console.log("Invalidating TRPC queries:", invalidateInfo.paths);
            queryClient.invalidateQueries({
              predicate: (q) => {
                // TRPC queries have queryKey like [["estate", "get"], { input: {...} }]
                const queryKey = q.queryKey as any[];
                if (!Array.isArray(queryKey) || !Array.isArray(queryKey[0])) {
                  return false;
                }

                // The path is the first element, joined with dots
                const path = queryKey[0].join(".");
                console.log("Checking query path:", path, "against", invalidateInfo.paths);
                return matchPath(path, invalidateInfo.paths);
              },
            });
          }
        } else if (payload.type === "NOTIFICATION") {
          const toastFn = toast[payload.notificationType] as typeof toast.success;
          toastFn(payload.message, {
            id: "app-control-notification",
            ...payload.extraToastArgs,
          });
        } else if (payload.type === "CUSTOM") {
          console.log("Custom control event", payload);
        }
      }
    });

    ws.addEventListener("close", () => {
      console.log("PartySocket disconnected");
      setIsConnected(false);

      // Clear ping interval if exists
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    });

    ws.addEventListener("error", (error) => {
      console.error("PartySocket error:", error);
    });

    // Cleanup function
    return () => {
      console.log("Cleaning up PartySocket connection");

      // Clear ping interval if exists
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl, queryClient]);

  const sendMessage = useCallback((message: any) => {
    if (wsRef.current?.readyState === PartySocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    console.warn("Cannot send message: WebSocket not connected");
    return false;
  }, []);

  return {
    isConnected,
    reconnectAttempts: (wsRef.current as any)?.retryCount || 0,
    connect: () => wsRef.current?.reconnect(),
    disconnect: () => wsRef.current?.close(),
    sendMessage,
  };
}

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { useWebSocket } from "partysocket/react";
import { useCallback, useMemo, useState } from "react";

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

export function useOrganizationWebSocket(organizationId: string, installationId: string) {
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);

  const wsUrl = useMemo(() => {
    const url = new URL(
      import.meta.env.SSR ? import.meta.env.VITE_PUBLIC_URL : window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/ws/${organizationId}`;
    url.searchParams.set("installationId", installationId);
    return url.toString();
  }, [organizationId, installationId]);

  const handleWebSocketMessage = useCallback(
    (event: MessageEvent) => {
      // Handle other messages
      if (typeof event.data === "string") {
        const maybeJson = tryParseJson(event.data);
        if (!maybeJson) {
          return;
        }

        // Handle connection confirmation
        if (maybeJson.type === "CONNECTED") {
          return;
        }

        // Handle echo messages (for debugging)
        if (maybeJson.type === "ECHO") {
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
            queryClient.invalidateQueries();
          } else if (invalidateInfo.type === "QUERY_KEY") {
            queryClient.invalidateQueries({
              queryKey: invalidateInfo.queryKeys,
              exact: false,
            });
          } else if (invalidateInfo.type === "TRPC_QUERY") {
            queryClient.invalidateQueries({
              predicate: (q) => {
                // TRPC queries have queryKey like [["installation", "get"], { input: {...} }]
                const queryKey = q.queryKey as any[];
                if (!Array.isArray(queryKey) || !Array.isArray(queryKey[0])) {
                  return false;
                }

                // The path is the first element, joined with dots
                const path = queryKey[0].join(".");
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
    },
    [queryClient],
  );

  const websocketOptions = useMemo(
    () => ({
      maxReconnectionDelay: 10000,
      minReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1.3,
      connectionTimeout: 4000,
      maxRetries: Infinity, // Keep trying to reconnect
      minUptime: 5000, // Consider connection stable after 5 seconds
      onMessage: handleWebSocketMessage,
      onOpen: () => setIsConnected(true),
      onClose: () => setIsConnected(false),
    }),
    [handleWebSocketMessage],
  );

  const ws = useWebSocket(wsUrl, [], websocketOptions);

  return { ...ws, isConnected };
}

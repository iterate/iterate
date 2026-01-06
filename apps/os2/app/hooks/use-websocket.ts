import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod/v4";
import { useWebSocket } from "partysocket/react";
import { useCallback, useMemo, useState } from "react";

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

function tryParseJson(data: string) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function matchPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return path.startsWith(pattern.slice(0, -1));
    }
    return path === pattern;
  });
}

export function useOrganizationWebSocket(organizationId: string) {
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const shouldConnect = organizationId.length > 0;

  const wsUrl = useMemo(() => {
    const baseUrl = import.meta.env.SSR
      ? import.meta.env.VITE_PUBLIC_URL
      : window.location.origin;
    const url = new URL(baseUrl || "http://localhost:5173");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const organizationValue = shouldConnect ? organizationId : "placeholder";
    url.pathname = "/api/ws/" + organizationValue;
    url.searchParams.set("organizationId", organizationValue);
    return url.toString();
  }, [organizationId, shouldConnect]);

  const handleWebSocketMessage = useCallback(
    (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }

      const maybeJson = tryParseJson(event.data);
      if (!maybeJson) {
        return;
      }

      if (maybeJson.type === "CONNECTED" || maybeJson.type === "ECHO") {
        return;
      }

      const parsed = PushControllerEvent.safeParse(maybeJson);
      if (!parsed.success) {
        return;
      }

      const payload: PushControllerEvent = parsed.data;

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
            predicate: (query) => {
              const queryKey = query.queryKey as unknown[];
              if (!Array.isArray(queryKey) || !Array.isArray(queryKey[0])) {
                return false;
              }
              const path = queryKey[0].join(".");
              return matchPath(path, invalidateInfo.paths);
            },
          });
        }
        return;
      }

      if (payload.type === "NOTIFICATION") {
        const toastFn = toast[payload.notificationType] as typeof toast.success;
        toastFn(payload.message, {
          id: "app-control-notification",
          ...payload.extraToastArgs,
        });
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
      maxRetries: Infinity,
      minUptime: 5000,
      startClosed: !shouldConnect,
      onMessage: handleWebSocketMessage,
      onOpen: () => setIsConnected(true),
      onClose: () => setIsConnected(false),
    }),
    [handleWebSocketMessage, shouldConnect],
  );

  const ws = useWebSocket(wsUrl, [], websocketOptions);

  return { ...ws, isConnected };
}

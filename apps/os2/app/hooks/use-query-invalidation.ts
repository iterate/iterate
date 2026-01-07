import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useQueryInvalidation(organizationId: string | undefined) {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!organizationId) return;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/invalidate?organizationId=${organizationId}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = undefined;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "INVALIDATE_ALL") {
            queryClient.invalidateQueries();
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 30000);

      return () => {
        clearInterval(pingInterval);
        ws.close();
      };
    };

    const cleanup = connect();

    return () => {
      cleanup?.();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [organizationId, queryClient]);
}

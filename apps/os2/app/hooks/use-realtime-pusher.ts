import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

const DEBUG = import.meta.env.DEV;

function log(...args: unknown[]) {
  if (DEBUG) {
    console.log("[RealtimePusher]", ...args);
  }
}

export function useRealtimePusher() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/realtime`;

      log("Connecting to", url);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        log("WebSocket connected");
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = undefined;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          log("Received message:", data);
          if (data.type === "INVALIDATE_ALL") {
            log("Invalidating all queries");
            queryClient.invalidateQueries();
          }
        } catch {
          log("Failed to parse message:", event.data);
        }
      };

      ws.onclose = (event) => {
        log("WebSocket closed:", event.code, event.reason);
        wsRef.current = null;
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        log("WebSocket error:", error);
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
  }, [queryClient]);
}

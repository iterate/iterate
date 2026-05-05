import { useEffect, useMemo, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import ReconnectingWebSocket, {
  type Options as ReconnectingWebSocketOptions,
} from "partysocket/ws";

export type DurableObjectViewConnectionState = "connecting" | "connected" | "disconnected";

export type UseDurableObjectViewOptions<TView> = {
  queryKey: QueryKey;
  view: string;
  durableObjectPath?: string;
  webSocketUrl?: string;
  reconnect?: ReconnectingWebSocketOptions;
  initialData?: TView;
};

export type UseDurableObjectViewResult<TView> = UseQueryResult<TView> & {
  connectionState: DurableObjectViewConnectionState;
  latestRevision: string | null;
};

/**
 * Subscribes a React component to a named Durable Object view.
 *
 * The server-side `withDurableObjectViews()` mixin sends complete replacement
 * values over `withHibernatingWebSockets()`. This hook keeps the client-side
 * concept deliberately higher level: callers provide a Durable Object public
 * path and a view name, while Cloudflare's hibernation route and WebSocket
 * details stay hidden behind the hook.
 *
 * TanStack Query remains the React cache. Incoming WebSocket messages call
 * `queryClient.setQueryData(queryKey, value)`, so every component using the
 * same key observes the synchronized view without owning a separate socket.
 *
 * First-party TanStack Query docs for `setQueryData()`:
 * https://tanstack.com/query/latest/docs/reference/QueryClient/#queryclientsetquerydata
 */
export function useDurableObjectView<TView>(
  options: UseDurableObjectViewOptions<TView>,
): UseDurableObjectViewResult<TView> {
  const { durableObjectPath, initialData, queryKey, reconnect, view, webSocketUrl } = options;
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] =
    useState<DurableObjectViewConnectionState>("connecting");
  const [latestRevision, setLatestRevision] = useState<string | null>(null);
  const resolvedWebSocketUrl = useMemo(
    () => createDurableObjectViewWebSocketUrl({ durableObjectPath, view, webSocketUrl }),
    [durableObjectPath, view, webSocketUrl],
  );

  const query = useQuery<TView>({
    queryKey,
    enabled: false,
    staleTime: Infinity,
    initialData,
    queryFn: async () => {
      const cached = queryClient.getQueryData<TView>(queryKey);
      if (cached !== undefined) return cached;

      throw new Error(
        "Durable Object views are delivered over WebSocket; this query is populated by useDurableObjectView().",
      );
    },
  });

  useEffect(() => {
    setConnectionState("connecting");

    const socket = new ReconnectingWebSocket(resolvedWebSocketUrl, [], {
      maxRetries: Infinity,
      minReconnectionDelay: 1_000,
      maxReconnectionDelay: 10_000,
      ...reconnect,
    });

    socket.addEventListener("open", () => setConnectionState("connected"));
    socket.addEventListener("close", () => setConnectionState("disconnected"));
    socket.addEventListener("error", () => setConnectionState("disconnected"));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      const message = parseDurableObjectViewMessage(event.data);
      if (message === null || message.view !== view) return;

      queryClient.setQueryData(queryKey, message.value as TView);
      setLatestRevision(message.revision);
    });

    return () => {
      socket.close();
    };
  }, [queryKey, queryClient, reconnect, resolvedWebSocketUrl, view]);

  return {
    ...query,
    connectionState,
    latestRevision,
  };
}

function createDurableObjectViewWebSocketUrl(options: {
  durableObjectPath?: string;
  webSocketUrl?: string;
  view: string;
}): string {
  const durableObjectPath = options.durableObjectPath;

  if (options.webSocketUrl === undefined && durableObjectPath === undefined) {
    throw new Error("useDurableObjectView() requires durableObjectPath or webSocketUrl.");
  }

  if (options.webSocketUrl !== undefined && durableObjectPath !== undefined) {
    throw new Error("useDurableObjectView() accepts either durableObjectPath or webSocketUrl.");
  }

  let url: URL;
  if (options.webSocketUrl !== undefined) {
    url = new URL(options.webSocketUrl, window.location.href);
  } else {
    if (durableObjectPath === undefined) {
      throw new Error("useDurableObjectView() requires durableObjectPath or webSocketUrl.");
    }

    url = new URL(`${durableObjectPath.replace(/\/$/, "")}/__websocket`, window.location.href);
  }

  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.append("view", options.view);

  return url.toString();
}

function parseDurableObjectViewMessage(raw: string) {
  try {
    const value = JSON.parse(raw) as unknown;
    return isDurableObjectViewMessage(value) ? value : null;
  } catch {
    return null;
  }
}

function isDurableObjectViewMessage(value: unknown): value is {
  kind: "durable-object-view";
  view: string;
  revision: string;
  value: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || value.kind !== "durable-object-view") return false;
  if (!("view" in value) || typeof value.view !== "string") return false;
  if (!("revision" in value) || typeof value.revision !== "string") return false;
  return "value" in value;
}

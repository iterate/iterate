import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { StreamEventBatch } from "iterate/processors";
import { useStreamConnection, type StreamEvent } from "iterate/sdk/itx/react";
import { mergeEventsByOffset } from "./chat.ts";

/**
 * Read one stream into TanStack Query, then keep that cache live through the
 * shared reconnecting stream-connection hook. The replay cursor is read when
 * opening the connection, closing the read-then-connect race without owning any
 * transport lifecycle in the app.
 */
export function useLiveEvents(input: {
  enabled: boolean;
  eventTypes: readonly string[] | undefined;
  projectId: string;
  queryKey: QueryKey;
  read: () => Promise<StreamEvent[]>;
  streamPath: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: input.queryKey,
    queryFn: async () => {
      const initial = await input.read();
      const pushed = queryClient.getQueryData<StreamEvent[]>(input.queryKey) || [];
      return mergeEventsByOffset(pushed, initial);
    },
    enabled: input.enabled,
    staleTime: Infinity,
  });

  const connection = useStreamConnection(
    async (itx) => {
      const existing = queryClient.getQueryData<StreamEvent[]>(input.queryKey) || [];
      return await itx.streams.get(input.streamPath).openConnection({
        replayAfterOffset: existing.reduce((max, event) => Math.max(max, event.offset), 0),
        ...(!input.eventTypes ? {} : { eventTypes: input.eventTypes }),
        processEventBatch: (batch: StreamEventBatch) => {
          queryClient.setQueryData<StreamEvent[]>(input.queryKey, (current) =>
            mergeEventsByOffset(current || [], batch.events),
          );
        },
      });
    },
    [input.streamPath, input.eventTypes, ...input.queryKey],
    { enabled: input.enabled && query.isSuccess, slug: input.projectId },
  );

  const connectionError = connection.status === "error" ? new Error(connection.error) : undefined;
  const error = query.error || connectionError;
  return {
    ...query,
    // `isError` is the discriminant consumed by both screens. TanStack's
    // generic result cannot express the connection half of that union, so
    // retain the runtime invariant explicitly.
    error: error!,
    isError: !!error,
    refetch: () => {
      connection.refresh();
      return query.refetch();
    },
  };
}

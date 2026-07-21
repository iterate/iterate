import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useItxSubscription, type StreamEvent, type StreamEventBatch } from "iterate/react";
import { mergeEventsByOffset } from "./chat.ts";

/**
 * Read one stream into TanStack Query, then keep that cache live through the
 * shared reconnecting itx subscription hook. The replay cursor is read at
 * subscription time, closing the read-then-subscribe race without owning any
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

  const subscription = useItxSubscription(
    async (itx) => {
      const existing = queryClient.getQueryData<StreamEvent[]>(input.queryKey) || [];
      return await itx.streams.get(input.streamPath).subscribe({
        replayAfterOffset: existing.reduce((max, event) => Math.max(max, event.offset), 0),
        ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
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

  const subscriptionError =
    subscription.status === "error" ? new Error(subscription.error) : undefined;
  const error = query.error || subscriptionError;
  return {
    ...query,
    // `isError` is the discriminant consumed by both screens. TanStack's
    // generic result cannot express the subscription half of that union, so
    // retain the runtime invariant explicitly.
    error: error!,
    isError: error !== undefined,
    refetch: () => {
      subscription.refresh();
      return query.refetch();
    },
  };
}

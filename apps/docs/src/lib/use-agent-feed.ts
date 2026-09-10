import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, FeedLiveState, LiveStateRpc } from "iterate/client";
import { useLiveState } from "iterate/sdk/capnweb/react";
import { FEED_ITEM_PUBLISHED } from "@iterate-com/ui/components/events/feed-publication";
import { dialDocsApi, withDocsProject } from "./docs-client.ts";
import { foldFeedPublications, type FeedFold, type FeedStreamEvent } from "./agent-feed.ts";
import { useStreamConnection, type StreamConnectionStatus } from "./use-stream-connection.ts";

const HISTORY_PAGE_SIZE = 500;

/** Where the agent sharing a workspace stands, as the feed pane needs it. */
type AgentFeed = {
  /** Newest revision of every published item, in display order. */
  items: FeedFold["items"];
  /**
   * The server's current presentation — live activity, queued messages,
   * presence, usage, runtime — shown only once its publications have
   * arrived, so a settling activity is never both live and settled.
   */
  live: FeedLiveState | undefined;
  /** The publications connection: "live", or what stands in its way. */
  connectionStatus: StreamConnectionStatus;
  /** The live-state subscription's transport. */
  liveStatus: "connecting" | "live" | "error";
  /** Birth and history done: the pane can render and send. */
  ready: boolean;
  error: string | null;
};

/**
 * One agent's feed, straight from the platform: the agent's own stream
 * (which is the workspace's stream) delivers `feed/item-published`
 * revisions over a retained-callback connection, and its `feedLiveState`
 * pushes the in-flight tail. Nothing here interprets a domain event. The
 * first mount births the agent when its processor has never been born.
 */
export function useAgentFeed(agentPath: string): AgentFeed {
  const [events, setEvents] = useState<Map<number, FeedStreamEvent>>(() => new Map());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Birth if needed, then the durable history — before the live connection
  // opens, so its replay cursor closes the gap between the two reads.
  useEffect(() => {
    let cancelled = false;
    setEvents(new Map());
    setReady(false);
    setError(null);
    void withDocsProject(async (project) => {
      const agent = await project.agent(agentPath);
      const snapshot = await agent.processor.snapshot();
      if ((snapshot.state?.birthCertificate ?? null) === null) await agent.create();
      const history: FeedStreamEvent[] = [];
      let afterOffset = 0;
      for (;;) {
        const page = await agent.stream.getEvents({
          afterOffset,
          eventTypes: [FEED_ITEM_PUBLISHED],
          limit: HISTORY_PAGE_SIZE,
        });
        history.push(...page);
        if (page.length < HISTORY_PAGE_SIZE) return history;
        afterOffset = page.at(-1)!.offset;
      }
    })
      .then((history) => {
        if (cancelled) return;
        setEvents(new Map(history.map((event) => [event.offset, event])));
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [agentPath]);

  const onBatch = useCallback((batch: FeedStreamEvent[]) => {
    setEvents((current) => {
      const next = new Map(current);
      for (const event of batch) next.set(event.offset, event);
      return next;
    });
  }, []);
  const openConnection = useCallback(
    (deliver: (events: FeedStreamEvent[]) => void, afterOffset: number) =>
      withDocsProject(async (project) => {
        const agent = await project.agent(agentPath);
        const connection = await agent.stream.openConnection({
          eventTypes: [FEED_ITEM_PUBLISHED],
          processEventBatch: (batch) => deliver(batch.events),
          replayAfterOffset: afterOffset,
        });
        return { ping: () => connection.ping(), unsubscribe: () => connection.close() };
      }),
    [agentPath],
  );
  const { status: connectionStatus } = useStreamConnection({
    enabled: ready,
    open: openConnection,
    onBatch,
  });

  const fold = useMemo(() => foldFeedPublications(events.values()), [events]);

  // The live snapshot rides its own socket: the shared session's redials
  // (any transport failure elsewhere) must not drop it, and the SDK hook
  // owns reconnect, patch assembly, and the watchdog.
  const makeConnection = useCallback(() => {
    const { project, session } = dialDocsApi();
    return {
      project,
      onRpcBroken: (callback: (error?: unknown) => void) => session.onRpcBroken(callback),
      [Symbol.dispose]: () => session[Symbol.dispose](),
    };
  }, []);
  const liveState = useLiveState(
    (root: ReturnType<typeof makeConnection>) =>
      // Pipelined through the vessel's `agent()` promise: capnweb resolves
      // the property chain on the stub, so no round trip precedes the
      // subscribe call.
      (root.project.agent(agentPath) as unknown as Agent).stream
        .feedLiveState as unknown as LiveStateRpc<FeedLiveState>,
    (state) => state,
    [agentPath],
    { enabled: ready, makeConnection },
  );

  // The handoff barrier: a snapshot that already accounts for a publication
  // this fold has not seen yet would remove a live activity before its
  // settled row exists, so the previous snapshot stays until the
  // publications catch up. The reverse order hides the live activity whose
  // id is already published.
  const presented = useRef<FeedLiveState | undefined>(undefined);
  const incoming = liveState.value;
  if (incoming !== undefined && incoming.publicationOffset <= fold.latestPublicationOffset) {
    presented.current = incoming;
  }
  const live = useMemo(() => {
    const snapshot = presented.current;
    if (snapshot === undefined) return undefined;
    // A preview the server omitted for size carries no agent presentation.
    const liveActivity = snapshot.agent?.live ?? null;
    if (liveActivity === null || !fold.publishedIds.has(liveActivity.id)) return snapshot;
    return { ...snapshot, agent: { ...snapshot.agent, live: null } } as FeedLiveState;
    // presented.current changes exactly when incoming or the fold does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, fold]);

  return {
    items: fold.items,
    live,
    connectionStatus,
    liveStatus: liveState.status,
    ready,
    error: error ?? liveState.error ?? null,
  };
}

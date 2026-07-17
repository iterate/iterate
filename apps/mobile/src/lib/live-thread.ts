// Live agent-thread data: one stream subscription per (server, project, agent),
// pushing every server-sent batch straight into the tanstack-query cache that
// the chat screen renders from. Keeping the subscription OUTSIDE React (keyed
// module map, same pattern as itx.ts's session cache) means screens are plain
// useQuery consumers — no effects, no hand-rolled socket state.
//
// Recovery is deliberately simpler than the web's useItxSubscription
// (`iterate/react`'s useItxSubscription): a ping watchdog per subscription; on any
// failure the subscription and itx session are dropped so the next watchdog
// tick or screen focus re-dials and replays from the last seen offset.

import type { StreamEvent, StreamEventBatch } from "../../../os/src/itx-api.generated.ts";
import { mergeEventsByOffset } from "./chat.ts";
import { getItxSession, resetItxSession } from "./itx.ts";
import { queryClient } from "./query.ts";

const WATCHDOG_INTERVAL_MS = 15_000;

type ThreadKey = string;
type LiveSubscription = {
  stop: () => void;
};

// Promises, not resolved values: the first caller claims the key
// synchronously so concurrent loads never double-subscribe.
const subscriptions = new Map<ThreadKey, Promise<LiveSubscription>>();

export function threadQueryKey(baseUrl: string, projectId: string, agentPath: string) {
  return ["thread-events", baseUrl, projectId, agentPath] as const;
}

/**
 * Read the current page of events AND keep the thread live. Designed as a
 * queryFn: the initial read resolves the query, then pushed batches update it
 * via setQueryData. Idempotent per thread — repeat calls (refetch, remount)
 * reuse the existing subscription.
 */
export async function loadAndFollowThread(
  baseUrl: string,
  projectId: string,
  agentPath: string,
): Promise<StreamEvent[]> {
  const key = threadQueryKey(baseUrl, projectId, agentPath);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get(agentPath);
  const initial = await stream.getEvents({});

  const mapKey: ThreadKey = JSON.stringify(key);
  if (!subscriptions.has(mapKey)) {
    const subscription = subscribeThread(baseUrl, projectId, agentPath, mapKey).catch((error) => {
      subscriptions.delete(mapKey);
      throw error;
    });
    subscriptions.set(mapKey, subscription);
  }
  await subscriptions.get(mapKey);
  const cached = queryClient.getQueryData<StreamEvent[]>(key) || [];
  return mergeEventsByOffset(cached, initial);
}

async function subscribeThread(
  baseUrl: string,
  projectId: string,
  agentPath: string,
  mapKey: ThreadKey,
): Promise<LiveSubscription> {
  const key = threadQueryKey(baseUrl, projectId, agentPath);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get(agentPath);

  const alreadySeen = queryClient.getQueryData<StreamEvent[]>(key) || [];
  const handle = await stream.subscribe({
    replayAfterOffset: alreadySeen.reduce((max, event) => Math.max(max, event.offset), 0),
    processEventBatch: (batch: StreamEventBatch) => {
      queryClient.setQueryData<StreamEvent[]>(key, (existing) =>
        mergeEventsByOffset(existing || [], batch.events),
      );
    },
  });

  // A half-open socket delivers nothing and errors nothing; the ping is the
  // only way to notice. ping() resolves false once the subscription was
  // replaced/closed and rejects when the stream DO is gone — either way, drop
  // everything so the next queryFn run (refetch/focus) re-subscribes and
  // replays from the last seen offset.
  const watchdog = setInterval(() => {
    void Promise.resolve(handle.ping())
      .then((alive) => {
        if (alive !== true) throw new Error("subscription closed");
      })
      .catch(() => {
        stop();
        resetItxSession();
        void queryClient.refetchQueries({ queryKey: key });
      });
  }, WATCHDOG_INTERVAL_MS);

  const stop = () => {
    clearInterval(watchdog);
    subscriptions.delete(mapKey);
    try {
      handle.unsubscribe();
    } catch {
      // socket already gone
    }
  };
  return { stop };
}

/** Drop every live subscription (sign-out / server switch). */
export function stopAllThreads(): void {
  for (const subscription of [...subscriptions.values()]) {
    void subscription.then((s) => s.stop()).catch(() => {});
  }
  subscriptions.clear();
}

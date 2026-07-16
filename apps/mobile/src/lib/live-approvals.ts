// Live human-approval events for one project's root stream — same
// outside-React module-level subscription pattern as live-thread.ts, so the
// approvals screen is a plain useQuery consumer. Filtered to the
// human-approval-* event types: a project's root stream can carry other
// project-level events (egress-rules-configured, etc.) this screen doesn't
// need.

import type { StreamEvent, StreamEventBatch } from "../../../os/src/itx-api.generated.ts";
import { EVENT } from "./approvals.ts";
import { mergeEventsByOffset } from "./chat.ts";
import { getItxSession, resetItxSession } from "./itx.ts";
import { queryClient } from "./query.ts";

const WATCHDOG_INTERVAL_MS = 15_000;
const APPROVAL_EVENT_TYPES = [EVENT.requested, EVENT.granted, EVENT.rejected, EVENT.settled];

type ApprovalsKey = string;
type LiveSubscription = { stop: () => void };

const subscriptions = new Map<ApprovalsKey, Promise<LiveSubscription>>();

export function approvalsQueryKey(baseUrl: string, projectId: string) {
  return ["approval-events", baseUrl, projectId] as const;
}

/** Read the current page of approval events AND keep them live. Designed as a queryFn — see live-thread.ts's loadAndFollowThread. */
export async function loadAndFollowApprovals(
  baseUrl: string,
  projectId: string,
): Promise<StreamEvent[]> {
  const key = approvalsQueryKey(baseUrl, projectId);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get("/");
  const initial = await stream.getEvents({ eventTypes: APPROVAL_EVENT_TYPES });

  const mapKey: ApprovalsKey = JSON.stringify(key);
  if (!subscriptions.has(mapKey)) {
    const subscription = subscribeApprovals(baseUrl, projectId, mapKey).catch((error) => {
      subscriptions.delete(mapKey);
      throw error;
    });
    subscriptions.set(mapKey, subscription);
  }
  await subscriptions.get(mapKey);
  const cached = queryClient.getQueryData<StreamEvent[]>(key) || [];
  return mergeEventsByOffset(cached, initial);
}

async function subscribeApprovals(
  baseUrl: string,
  projectId: string,
  mapKey: ApprovalsKey,
): Promise<LiveSubscription> {
  const key = approvalsQueryKey(baseUrl, projectId);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get("/");

  const alreadySeen = queryClient.getQueryData<StreamEvent[]>(key) || [];
  const handle = await stream.subscribe({
    replayAfterOffset: alreadySeen.reduce((max, event) => Math.max(max, event.offset), 0),
    eventTypes: APPROVAL_EVENT_TYPES,
    processEventBatch: (batch: StreamEventBatch) => {
      queryClient.setQueryData<StreamEvent[]>(key, (existing) =>
        mergeEventsByOffset(existing || [], batch.events),
      );
    },
  });

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
export function stopAllApprovals(): void {
  for (const subscription of [...subscriptions.values()]) {
    void subscription.then((s) => s.stop()).catch(() => {});
  }
  subscriptions.clear();
}

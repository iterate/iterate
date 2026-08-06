// The chat-reply push suppression claim: while the thread screen is showing
// the newest agent reply to a foregrounded user, tell push channels so — a
// `project/agent-reply-presented` claim that lands inside the device
// processor's reply grace window settles the pending push `suppressed` on
// EVERY device, and a late claim is a harmless no-op (the push simply goes
// out, the designed fallback). Same protocol as the approval-presented claim
// in components/in-thread-approval.tsx.

import { useQuery } from "@tanstack/react-query";
import { AppState } from "react-native";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { ASSISTANT_MESSAGE_TYPE } from "./chat.ts";
import { getProjectItx } from "./itx.ts";

/**
 * Claim the newest agent reply in this thread as "on screen". One claim per
 * reply per mount (useQuery keyed on the reply offset); the idempotency key
 * makes any refire a stream-level no-op, and failures are ignored. Only a
 * foregrounded app may claim — the queryFn WAITS for the foreground rather
 * than gating on a one-shot `enabled` read, so a reply that arrives while
 * the app is backgrounded is deliberately NOT claimed from here: the push is
 * exactly what should happen then.
 */
export function useClaimReplyPresented(input: {
  baseUrl: string | undefined;
  events: StreamEvent[];
  path: string;
  projectId: string;
}) {
  const { baseUrl, events, path, projectId } = input;
  const replyOffset = newestReplyOffset(events);
  useQuery({
    queryKey: ["reply-presented", projectId, path, replyOffset],
    enabled: baseUrl !== undefined && replyOffset !== null,
    queryFn: async () => {
      await appForegrounded();
      const project = await getProjectItx(baseUrl!, projectId);
      await project.streams.get("/").append({
        type: "events.iterate.com/project/agent-reply-presented",
        idempotencyKey: `project/agent-reply-presented:${path}:${replyOffset}`,
        payload: { path, replyEventOffset: replyOffset },
      });
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** The newest visible agent reply's offset in this thread, or null. */
function newestReplyOffset(events: StreamEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.type === ASSISTANT_MESSAGE_TYPE) return events[index]!.offset;
  }
  return null;
}

/**
 * Resolves once the app is foregrounded — immediately when it already is
 * (always, on web). One-shot: the listener removes itself on the first
 * "active" transition, so an abandoned wait leaks nothing beyond a single
 * subscription for the app's backgrounded lifetime.
 */
export function appForegrounded(): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      resolve();
    });
  });
}

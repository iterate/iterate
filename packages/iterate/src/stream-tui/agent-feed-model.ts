/**
 * In-memory agent conversation feed for the chat TUI.
 *
 * This is the node-side sibling of the browser database's feed projector
 * (apps/os/src/domains/streams/client-libraries/processors/browser-feed):
 * both fold the SAME shared reducer (`reduceAgentUi` from @iterate-com/ui)
 * over agent stream events. The browser persists settled items into SQLite for
 * a virtual list; a terminal session is ephemeral and small, so this model
 * keeps the settled items in a plain array and the streaming live activity in
 * the reduced state — no database, no processor host.
 */
import {
  initialAgentUiState,
  reduceAgentUi,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "../itx-api.generated.ts";

export type AgentFeedSnapshot = {
  /** Settled conversation items in list order (user, assistant, activity). */
  items: readonly AgentUiItem[];
  /** The in-flight activity with streaming thinking/response text, if any. */
  live: AgentUiState["live"];
  eventCount: number;
  /** Highest stream offset folded in — the resume cursor for re-subscribes. */
  lastOffset: number;
};

type AgentFeedModel = {
  snapshot(): AgentFeedSnapshot;
  /**
   * Fold a batch of stream events. Events at or below `lastOffset` are
   * ignored, so replay overlap after a reconnect is harmless. Returns true
   * when the snapshot changed.
   */
  applyEvents(events: readonly StreamEvent[]): boolean;
};

export function createAgentFeedModel(): AgentFeedModel {
  let state = initialAgentUiState();
  let items: AgentUiItem[] = [];
  let lastOffset = 0;
  let snapshot: AgentFeedSnapshot = { items, live: null, eventCount: 0, lastOffset };

  return {
    snapshot: () => snapshot,
    applyEvents(events) {
      const fresh = events.filter((event) => event.offset > lastOffset);
      if (fresh.length === 0) return false;

      lastOffset = fresh[fresh.length - 1]!.offset;
      let settledItems: AgentUiItem[] | null = null;
      for (const event of fresh) {
        const step = reduceAgentUi(state, event as unknown as Parameters<typeof reduceAgentUi>[1]);
        state = step.endState;
        if (step.items.length > 0) settledItems = [...(settledItems ?? []), ...step.items];
      }
      if (settledItems) items = [...items, ...settledItems];
      snapshot = { items, live: state.live, eventCount: state.eventCount, lastOffset };
      return true;
    },
  };
}

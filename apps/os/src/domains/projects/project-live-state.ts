import type { ProjectProcessorState } from "./project-processor-contract.ts";

/**
 * The project's LIVE state — what `itx.live` exposes and the dashboard renders.
 *
 * This is PROJECT state, NOT stream-processor state. The project Durable Object
 * assembles it from independent sources, each a peer slice:
 * - `reduced` — the event-sourced project facts (created flag, agent/repo/secret
 *   catalogs) folded by the project processor. One contributor, not the base.
 * - `streamsIndex` — a materialized view of the project's streams the DO keeps in
 *   its own SQLite (recency, counts). Nothing to do with the processor.
 * - `liveDemo` — plain DO memory, for the live-state playground.
 *
 * A `useLiveState` selector picks whichever slice a component renders, so a
 * change in one slice never re-renders watchers of another.
 */
export type ProjectLiveState = {
  /** Event-sourced project facts, folded by the project processor — one source among several. */
  reduced: ProjectProcessorState;
  /** Demo (stateful live state): a counter bumped by `itx.liveDemo.increment()`, seen by every watcher. */
  liveDemo: { count: number; lastActor: string | null };
  // streamsIndex arrives with StreamDatabase — a top-level PEER, never nested under the processor fold.
};

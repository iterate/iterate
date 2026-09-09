import type { StreamEvent } from "iterate/processors";

export const AGENT_KIND_PREFIX = "agent.";
export const RAW_KIND_PREFIX = "raw.";

/** Raw rows render the source event directly; pretty rows contain published feed items. */
export type RawFeedItemData =
  | { eventType: string; events: StreamEvent[] }
  | { events: StreamEvent[] };

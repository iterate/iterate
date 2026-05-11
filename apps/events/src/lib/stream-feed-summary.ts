import type { StreamFeedItem } from "~/lib/stream-feed-types.ts";

export type StreamFeedSummary = {
  rawEvents: number;
  semanticItems: number;
};

export function summarizeStreamFeed(feed: readonly StreamFeedItem[]): StreamFeedSummary {
  let rawEvents = 0;
  let semanticItems = 0;

  for (const item of feed) {
    if (item.kind === "event") {
      rawEvents += 1;
    } else {
      semanticItems += 1;
    }
  }

  return { rawEvents, semanticItems };
}

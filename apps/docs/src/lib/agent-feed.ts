/**
 * The feed of one agent, folded from its `feed/item-published` events: the
 * platform's feed facet publishes every renderable item as a complete
 * revision, so the browser keeps the newest revision per item and never
 * interprets a domain event. Pure: events in, items out.
 */
import type { AgentUiItem } from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  FEED_ITEM_PUBLISHED,
  FeedItemPublication,
} from "@iterate-com/ui/components/events/feed-publication";

/** One committed event, as the vessel's stream reads and connections deliver it. */
export type FeedStreamEvent = {
  offset: number;
  type: string;
  payload?: unknown;
};

/** What one fold of the publications says about the feed. */
export type FeedFold = {
  /** Newest revision per item, in display order. */
  items: AgentUiItem[];
  /** Ids with a durable publication — a live activity with one of these ids has settled. */
  publishedIds: ReadonlySet<string>;
  /** Highest publication event offset folded in: the cursor a live snapshot must not run ahead of. */
  latestPublicationOffset: number;
  /** Highest event offset seen at all: the replay cursor for reconnects. */
  lastOffset: number;
};

/**
 * Fold publications into items. Newest `revisionOffset` (then newest event)
 * wins per item id; display order is the item's FIRST publication event
 * offset, then its `ordinal`, so a correction keeps its row and a late first
 * publication appends. Replays and duplicates are harmless: the event offset
 * is the identity.
 */
export function foldFeedPublications(events: Iterable<FeedStreamEvent>): FeedFold {
  const byOffset = new Map<number, FeedStreamEvent>();
  for (const event of events) byOffset.set(event.offset, event);
  const ordered = [...byOffset.values()].sort((left, right) => left.offset - right.offset);
  const rows = new Map<
    string,
    {
      firstOffset: number;
      revisionOffset: number;
      eventOffset: number;
      item: AgentUiItem;
      ordinal: number;
    }
  >();
  let latestPublicationOffset = 0;
  let lastOffset = 0;
  for (const event of ordered) {
    lastOffset = Math.max(lastOffset, event.offset);
    if (event.type !== FEED_ITEM_PUBLISHED) continue;
    const parsed = FeedItemPublication.safeParse(event.payload);
    if (!parsed.success) continue;
    latestPublicationOffset = Math.max(latestPublicationOffset, event.offset);
    const publication = parsed.data;
    const existing = rows.get(publication.item.id);
    const newer =
      existing === undefined ||
      publication.revisionOffset > existing.revisionOffset ||
      (publication.revisionOffset === existing.revisionOffset &&
        event.offset > existing.eventOffset);
    rows.set(publication.item.id, {
      firstOffset: existing?.firstOffset ?? event.offset,
      revisionOffset: newer ? publication.revisionOffset : existing.revisionOffset,
      eventOffset: newer ? event.offset : existing.eventOffset,
      item: newer ? publication.item : existing.item,
      ordinal: newer ? publication.ordinal : existing.ordinal,
    });
  }
  const items = [...rows.values()]
    .sort((left, right) => left.firstOffset - right.firstOffset || left.ordinal - right.ordinal)
    .map((row) => row.item);
  return { items, publishedIds: new Set(rows.keys()), latestPublicationOffset, lastOffset };
}

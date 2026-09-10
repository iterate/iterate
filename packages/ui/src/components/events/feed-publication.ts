import { z } from "zod";
import { AgentUiItemSchema } from "./agent-ui-reducer.ts";

/** The feed processor's one event: a complete renderable feed item revision. */
export const FEED_ITEM_PUBLISHED = "events.iterate.com/feed/item-published";

/** Complete immutable revision. Position is retained when a late fact corrects the item. */
export const FeedItemPublication = z.strictObject({
  item: AgentUiItemSchema,
  firstOffset: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative(),
  revisionOffset: z.number().int().nonnegative(),
});
export type FeedItemPublication = z.infer<typeof FeedItemPublication>;

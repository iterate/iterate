// The experimental server host and the existing browser mirror share this
// pure fold. Feed ownership remains an open architecture decision.
export * from "../../../feed/projector.ts";
export {
  STREAM_FEED_SCHEMA_VERSION as BROWSER_FEED_SCHEMA_VERSION,
  initialStreamFeedState as initialBrowserFeedState,
  planStreamFeedOps as planBrowserFeedOps,
  isCurrentStreamFeedState as isCurrentBrowserFeedState,
  type StreamFeedState as BrowserFeedState,
} from "../../../feed/projector.ts";

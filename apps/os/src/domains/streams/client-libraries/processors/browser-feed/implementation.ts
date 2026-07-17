// The experimental server host and the existing browser mirror exercise one
// projector implementation. Browser views still use this compatibility seam;
// none have moved to Stream.liveState or Stream.getFeedItems().
export {
  StreamFeedContract as BrowserFeedContract,
  StreamFeedProcessor as BrowserFeedProcessor,
  STREAM_FEED_SCHEMA_VERSION as BROWSER_FEED_SCHEMA_VERSION,
  STREAM_FEED_TABLE as BROWSER_FEED_TABLE,
  ensureStreamFeedSchema as ensureBrowserFeedSchema,
} from "../../../feed/processor.ts";

// The browser processors that run for every opened stream.
//
// Every view of the same stream shares one runtime. That runtime downloads each
// event batch once and calls this fixed list of processors in order (see
// browser-stream-processor-group.ts). Views query the resulting tables in the
// shared SQLite database; they do not choose which processors run.
//
// Order matters. The raw-event cache runs first, reports event-consumption
// metrics, and stores a batch before the feed processor derives rendered rows.
//
// Each processor has its own StreamProcessorRunner and progress row, keyed by
// processor slug. The group requests server replay from the smallest stored
// checkpoint.

import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BROWSER_RAW_EVENTS_TABLES,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  ensureBrowserRawEventsSchema,
} from "../processors/browser-raw-events/implementation.ts";
import {
  BROWSER_FEED_SCHEMA_VERSION,
  BROWSER_FEED_TABLE,
  BrowserFeedContract,
  BrowserFeedProcessor,
  ensureBrowserFeedSchema,
} from "../processors/browser-feed/implementation.ts";
import type { BrowserProcessorConfig } from "./stream-browser-store.ts";

/**
 * The fixed processors called for every browser stream event batch.
 */
export const BROWSER_STREAM_PROCESSORS: readonly BrowserProcessorConfig[] = [
  {
    // The local event cache: the verbatim `events` log + its derived
    // `event_type_counts`. Owns PRAGMA user_version, so its schema setup clears
    // its tables when that version changes.
    slug: BrowserRawEventsContract.slug,
    schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
    tables: BROWSER_RAW_EVENTS_TABLES,
    ensureProjectionSchema: ensureBrowserRawEventsSchema,
    createProcessor({ stream, path, projectId, sql }) {
      return new BrowserRawEventsProcessor({ stream, path, projectId, sql });
    },
  },
  {
    // The rendered-feed projection every feed view queries. Shares the OPFS
    // file, so its schema resets use the per-processor progress metadata.
    slug: BrowserFeedContract.slug,
    schemaVersion: BROWSER_FEED_SCHEMA_VERSION,
    resetOnSchemaVersionChange: true,
    tables: [BROWSER_FEED_TABLE],
    ensureProjectionSchema: ensureBrowserFeedSchema,
    createProcessor({ stream, path, projectId, sql }) {
      return new BrowserFeedProcessor({ stream, path, projectId, sql });
    },
  },
];

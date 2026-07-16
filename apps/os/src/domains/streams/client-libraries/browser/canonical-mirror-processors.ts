// The single source of truth for what a browser stream mirror runs.
//
// Every view of a stream — however many, on however many pages — mirrors it
// through ONE runtime that downloads the stream once and fans each batch out to
// this fixed set of processors (see composite-browser-processor.ts). Views never
// choose processors; they just query whichever tables they need off the shared
// SQLite database. Adding a browser projection is a deliberate edit HERE, not a
// per-view decision.
//
// Order matters: the raw-events cache is first, which makes it the composite's
// PRIMARY (metrics bearer) and means it ingests before the feed projector folds.

import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BROWSER_RAW_EVENTS_TABLES,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  type BrowserRawEventsState,
} from "../processors/browser-raw-events/implementation.ts";
import {
  BROWSER_FEED_SCHEMA_VERSION,
  BROWSER_FEED_TABLE,
  BrowserFeedContract,
  BrowserFeedProcessor,
  type BrowserFeedState,
} from "../processors/browser-feed/implementation.ts";
import { browserProcessorStateStorage } from "./processor-state-storage.ts";
import type { BrowserProcessorConfig } from "./stream-browser-store.ts";

/**
 * The fixed canonical set the browser mirror hosts. Each member keeps its own
 * checkpoint row (keyed by the composite subscription plus its schema-versioned
 * processor slug) so incompatible projection state is never reopened. The
 * composite changes the server subscription identity and supplies that same
 * versioned key to every member's storage lane.
 */
export const CANONICAL_MIRROR_PROCESSORS: readonly BrowserProcessorConfig[] = [
  {
    // The local event cache: the verbatim `events` log + its derived
    // `event_type_counts`. Owns PRAGMA user_version, so it self-resets in
    // `prepare()` rather than through the mirror-meta lane.
    slug: BrowserRawEventsContract.slug,
    schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
    tables: BROWSER_RAW_EVENTS_TABLES,
    createProcessor({ stream, path, projectId, sql, subscriptionKey }) {
      const storage = browserProcessorStateStorage<BrowserRawEventsState>({
        sql,
        processorSlug: BrowserRawEventsContract.slug,
        subscriptionKey,
      });
      return new BrowserRawEventsProcessor({
        stream,
        path,
        projectId,
        sql,
        readState: storage.readState,
        writeState: storage.writeState,
      });
    },
  },
  {
    // The rendered-feed projection every feed view queries. Shares the OPFS
    // file, so its schema resets ride the mirror-meta lane.
    slug: BrowserFeedContract.slug,
    schemaVersion: BROWSER_FEED_SCHEMA_VERSION,
    resetOnSchemaVersionChange: true,
    tables: [BROWSER_FEED_TABLE],
    createProcessor({ stream, path, projectId, sql, subscriptionKey }) {
      const storage = browserProcessorStateStorage<BrowserFeedState>({
        sql,
        processorSlug: BrowserFeedContract.slug,
        subscriptionKey,
      });
      return new BrowserFeedProcessor({
        stream,
        path,
        projectId,
        sql,
        readState: storage.readState,
        writeState: storage.writeState,
      });
    },
  },
];

// The single source of truth for what a browser stream mirror runs.
//
// Every view of a stream — however many, on however many pages — mirrors it
// through ONE runtime that downloads the stream once and fans each batch out to
// this fixed set of processors (see composite-mirror-drive.ts). Views never
// choose processors; they just query whichever tables they need off the shared
// SQLite database. Adding a browser projection is a deliberate edit HERE, not a
// per-view decision.
//
// Order matters: the raw-events cache is first, which makes it the composite's
// PRIMARY (metrics bearer) and means it ingests before the feed projector folds.
//
// Each member is driven by its own StreamProcessorRunner whose progress lives
// in the transactional browser progress store (keyed by the member's REAL
// slug, so existing local caches survive unification) — no per-processor
// checkpoint wiring here.

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
 * The fixed canonical set the browser mirror hosts. Each member keeps its own
 * progress row (keyed by its real slug) so its local cache survives across
 * this unification — the composite only changes the SERVER subscription
 * identity, never a member's storage key.
 */
export const CANONICAL_MIRROR_PROCESSORS: readonly BrowserProcessorConfig[] = [
  {
    // The local event cache: the verbatim `events` log + its derived
    // `event_type_counts`. Owns PRAGMA user_version, so it self-resets in
    // its projection schema ensurer rather than through the mirror-meta lane.
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
    // file, so its schema resets ride the mirror-meta lane.
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

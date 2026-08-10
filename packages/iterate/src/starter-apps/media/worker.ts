// The MediaApp Durable Object: hosts the media stream processor and exposes
// the query surface (search/list/get) that gets mounted at `itx.media`.
// Search returns signed image URLs so an agent's answer can show the actual
// screenshot. No HTTP page — this app is an API, not a site.
import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type StreamEvent,
} from "../../sdk.ts";
import { mediaStreamPath } from "./app-ref.ts";
import { MediaProcessor, searchMediaItems, type MediaItem, type MediaState } from "./processor.ts";

export type MediaSearchHit = MediaItem & {
  /** Signed https URL for the image itself — paste into chat to show it. */
  url: string;
};

export class MediaApp extends StreamProcessorDurableObject<MediaState> {
  protected readonly streamPath = mediaStreamPath;
  protected createProcessor(deps: ProcessorHostDeps) {
    return new MediaProcessor(deps);
  }

  /** Project-worker event delivery calls this after a durable /media event
   * commits. Catch-up owns validation, ordering, checkpointing, and dedupe. */
  async syncEvent(event: StreamEvent): Promise<void> {
    if (event.path !== mediaStreamPath) return;
    const registry = await this.registry();
    await registry.catchUp("media");
    registry.refreshLive();
  }

  /**
   * Keyword search over descriptions, OCR transcripts, filenames, and tags —
   * "train ticket" finds the train ticket because the vision model's prose
   * says so. `tags` all must be present; newest first; default limit 20.
   */
  async search(query: { q?: string; tags?: string[]; limit?: number }): Promise<MediaSearchHit[]> {
    const registry = await this.registry();
    await registry.catchUp("media");
    const { state } = await this.snapshot();
    const hits = searchMediaItems(state, query);
    using project = await this.env.ITX.get();
    return await Promise.all(
      hits.map(async (item) => ({ ...item, url: await project.files.get(item.path).url() })),
    );
  }

  /** Newest items, no filtering — `search` with an empty query. */
  async list(query: { limit?: number }): Promise<MediaSearchHit[]> {
    return this.search({ limit: query.limit });
  }

  /** One item by its content hash, or null. */
  async get(stableKey: string): Promise<MediaItem | null> {
    const registry = await this.registry();
    await registry.catchUp("media");
    const { state } = await this.snapshot();
    return state.items[stableKey] || null;
  }
}

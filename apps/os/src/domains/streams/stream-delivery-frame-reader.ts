import type { StreamEvent } from "./schemas.ts";
import type { SelectedStreamFrame, SizedStreamEvent } from "./stream-storage.ts";
import {
  DELIVERY_BATCH_BYTE_LIMIT,
  DELIVERY_BATCH_LIMIT,
  PUSH_DELIVERY_BATCH_BYTE_LIMIT,
  PUSH_DELIVERY_BATCH_LIMIT,
} from "./subscriber-math.ts";

const MAX_PUSH_STORAGE_READ_CACHE_ENTRIES = 2;

type DeliveryFrameReaderHooks = {
  readEvents(args: {
    afterOffset: number;
    throughOffset: number;
    limit: number;
  }): SizedStreamEvent[];
  scanPushEventTypesFrame?(args: {
    afterOffset: number;
    throughOffset: number;
    eventTypes: readonly string[];
    rawLimit: number;
    selectedByteLimit: number;
  }): SelectedStreamFrame;
};

export type DeliveryFrameProjection = {
  afterOffset: number;
  throughOffset: number;
  limit: number;
  byteLimit: number;
  scannedEventCount: number;
  selectedEventTypesKey?: string;
  selectedThroughOffset?: number;
  includesEventByteLengths: boolean;
  events: StreamEvent[];
  durableEvents: StreamEvent[];
  eventByteLengths: readonly number[] | undefined;
  durableEventByteLengths: readonly number[] | undefined;
  byteLength: number;
  durableByteLength: number;
  lastOffset: number | undefined;
  stoppedByByteLimit: boolean;
};

export type DeliveryFrame = {
  events: StreamEvent[];
  scannedEventCount: number;
  lastOffset: number | undefined;
  eventByteLengths: readonly number[] | undefined;
  byteLength: number;
  projection: DeliveryFrameProjection | undefined;
  durableOnly: boolean;
  stoppedByByteLimit: boolean;
};

export type DeliveryFrameRequest = {
  afterOffset: number;
  limit: number;
  throughOffset: number;
  durableOnly?: boolean;
  includeEventByteLengths?: boolean;
  byteLimit?: number;
  selectedEventTypes?: readonly string[];
};

export class StreamDeliveryFrameReader {
  readonly #hooks: DeliveryFrameReaderHooks;
  #freshTail: SizedStreamEvent[] = [];
  #freshTailByteLength = 0;
  #freshTailProjection: DeliveryFrameProjection | undefined;
  #freshTailSizedProjection: DeliveryFrameProjection | undefined;
  readonly #storageReadLimitHints = new Map<number, number>();
  readonly #storageReadCachesByByteLimit = new Map<
    number,
    { afterOffset: number; throughOffset: number; limit: number; entries: SizedStreamEvent[] }[]
  >();
  readonly #storageReadProjectionsByByteLimit = new Map<number, DeliveryFrameProjection[]>();

  constructor(hooks: DeliveryFrameReaderHooks) {
    this.#hooks = hooks;
  }

  onWake(args: {
    freshTail?: SizedStreamEvent[];
    freshTailByteLength?: number;
    retainContiguousTail: boolean;
  }): void {
    this.#storageReadCachesByByteLimit.clear();
    this.#storageReadProjectionsByByteLimit.clear();
    const { freshTail, freshTailByteLength, retainContiguousTail } = args;
    if (freshTail === undefined || freshTail.length === 0) return;

    const retainedLastOffset = this.#freshTail.at(-1)?.event.offset;
    const incomingFirstOffset = freshTail[0]!.event.offset;
    const contiguous =
      retainedLastOffset !== undefined && incomingFirstOffset === retainedLastOffset + 1;
    const withinRowLimit = this.#freshTail.length + freshTail.length <= PUSH_DELIVERY_BATCH_LIMIT;
    const incomingBytes =
      freshTailByteLength ?? freshTail.reduce((sum, entry) => sum + entry.byteLength, 0);
    if (
      retainContiguousTail &&
      contiguous &&
      withinRowLimit &&
      this.#freshTailByteLength + incomingBytes <= PUSH_DELIVERY_BATCH_BYTE_LIMIT
    ) {
      this.#freshTail.push(...freshTail);
      this.#freshTailByteLength += incomingBytes;
    } else {
      this.#freshTail = freshTail;
      this.#freshTailByteLength = incomingBytes;
    }
    this.#freshTailProjection = undefined;
    this.#freshTailSizedProjection = undefined;
  }

  /** Read a row- and byte-capped frame, preferring the contiguous committed tail over SQLite. */
  read(request: DeliveryFrameRequest): DeliveryFrame {
    const {
      afterOffset,
      limit,
      throughOffset,
      durableOnly = false,
      includeEventByteLengths = false,
      byteLimit = DELIVERY_BATCH_BYTE_LIMIT,
      selectedEventTypes,
    } = request;
    const selectedEventTypesKey =
      selectedEventTypes === undefined || this.#hooks.scanPushEventTypesFrame === undefined
        ? undefined
        : selectedEventTypes.join("\u0000");
    const firstFreshOffset = this.#freshTail[0]?.event.offset;
    const freshStart = firstFreshOffset === undefined ? -1 : afterOffset + 1 - firstFreshOffset;
    const useFreshTail =
      freshStart >= 0 && this.#freshTail[freshStart]?.event.offset === afterOffset + 1;
    const cached = useFreshTail
      ? includeEventByteLengths
        ? this.#freshTailSizedProjection
        : (this.#freshTailProjection ?? this.#freshTailSizedProjection)
      : this.#storageReadProjectionsByByteLimit
          .get(byteLimit)
          ?.find(
            (projection) =>
              projection.afterOffset === afterOffset &&
              projection.throughOffset === throughOffset &&
              projection.limit === limit &&
              projection.byteLimit === byteLimit &&
              (selectedEventTypesKey === undefined
                ? projection.selectedEventTypesKey === undefined
                : projection.selectedEventTypesKey === undefined ||
                  (projection.selectedEventTypesKey === selectedEventTypesKey &&
                    projection.selectedThroughOffset === throughOffset)) &&
              (!includeEventByteLengths || projection.includesEventByteLengths),
          );
    if (
      cached !== undefined &&
      cached.afterOffset === afterOffset &&
      cached.throughOffset === throughOffset &&
      cached.limit === limit &&
      cached.byteLimit === byteLimit &&
      (!includeEventByteLengths || cached.includesEventByteLengths)
    ) {
      return {
        events: (durableOnly ? cached.durableEvents : cached.events).slice(),
        scannedEventCount: cached.scannedEventCount,
        lastOffset: cached.lastOffset,
        eventByteLengths: durableOnly ? cached.durableEventByteLengths : cached.eventByteLengths,
        byteLength: durableOnly ? cached.durableByteLength : cached.byteLength,
        projection: cached,
        durableOnly,
        stoppedByByteLimit: cached.stoppedByByteLimit,
      };
    }

    const hintedLimit = this.#storageReadLimitHints.get(byteLimit);
    const storageLimit =
      selectedEventTypesKey === undefined ? Math.min(limit, hintedLimit ?? limit) : limit;
    const storageReadCaches = this.#storageReadCachesByByteLimit.get(byteLimit);
    const cachedStorageRead = storageReadCaches?.find(
      (entry) =>
        entry.afterOffset === afterOffset &&
        entry.throughOffset === throughOffset &&
        entry.limit === storageLimit,
    );
    const sourceFromStorageCache = !useFreshTail && cachedStorageRead !== undefined;
    if (
      !useFreshTail &&
      !sourceFromStorageCache &&
      selectedEventTypesKey !== undefined &&
      selectedEventTypes !== undefined &&
      this.#hooks.scanPushEventTypesFrame !== undefined
    ) {
      const selected = this.#hooks.scanPushEventTypesFrame({
        afterOffset,
        throughOffset,
        eventTypes: selectedEventTypes,
        rawLimit: storageLimit,
        selectedByteLimit: byteLimit,
      });
      const events = selected.events.map((entry) => entry.event);
      const eventByteLengths = selected.events.map((entry) => entry.byteLength);
      const projection: DeliveryFrameProjection = {
        afterOffset,
        throughOffset,
        limit,
        byteLimit,
        scannedEventCount: selected.scannedRawRows,
        selectedEventTypesKey,
        selectedThroughOffset: throughOffset,
        includesEventByteLengths: true,
        events,
        durableEvents: events,
        eventByteLengths,
        durableEventByteLengths: eventByteLengths,
        byteLength: selected.byteLength,
        durableByteLength: selected.byteLength,
        lastOffset: selected.rawThroughOffset,
        stoppedByByteLimit: selected.stoppedByByteLimit,
      };
      if (selected.byteLength <= byteLimit) {
        const projections = this.#storageReadProjectionsByByteLimit.get(byteLimit) ?? [];
        projections.unshift(projection);
        this.#storageReadProjectionsByByteLimit.set(byteLimit, projections);
        const maxEntries =
          byteLimit === PUSH_DELIVERY_BATCH_BYTE_LIMIT ? MAX_PUSH_STORAGE_READ_CACHE_ENTRIES : 1;
        if (projections.length > maxEntries) projections.pop();
      }
      return {
        events: events.slice(),
        scannedEventCount: selected.scannedRawRows,
        lastOffset: selected.rawThroughOffset,
        eventByteLengths,
        byteLength: selected.byteLength,
        projection,
        durableOnly: true,
        stoppedByByteLimit: selected.stoppedByByteLimit,
      };
    }

    const source = useFreshTail
      ? this.#freshTail
      : sourceFromStorageCache
        ? cachedStorageRead.entries
        : this.#hooks.readEvents({ afterOffset, throughOffset, limit: storageLimit });
    const start = useFreshTail ? freshStart : 0;
    const events: StreamEvent[] = [];
    let durable: StreamEvent[] | undefined;
    const eventByteLengths: number[] | undefined = includeEventByteLengths ? [] : undefined;
    let durableEventByteLengths: number[] | undefined;
    let lastOffset: number | undefined;
    let bytes = 0;
    let durableBytes = 0;
    let exceededByteLimit = false;
    let crossingEntryByteLength = 0;
    const count = Math.min(source.length - start, limit);
    for (let index = 0; index < count; index += 1) {
      const entry = source[start + index]!;
      if (entry.event.offset > throughOffset) break;
      const entryByteLength = entry.byteLength;
      const nextBytes = bytes + entryByteLength;
      if (nextBytes > byteLimit && index > 0) {
        exceededByteLimit = true;
        crossingEntryByteLength = entryByteLength;
        break;
      }
      events.push(entry.event);
      eventByteLengths?.push(entryByteLength);
      lastOffset = entry.event.offset;
      if (entry.event.ephemeral === true) {
        durable ??= events.slice(0, -1);
        if (eventByteLengths !== undefined) {
          durableEventByteLengths ??= eventByteLengths.slice(0, -1);
        }
      } else {
        durable?.push(entry.event);
        durableEventByteLengths?.push(entryByteLength);
        durableBytes += entryByteLength;
      }
      bytes = nextBytes;
    }
    if (!useFreshTail && !exceededByteLimit && source.length < storageLimit) {
      lastOffset = throughOffset;
    }
    if (!useFreshTail && (limit === DELIVERY_BATCH_LIMIT || limit === PUSH_DELIVERY_BATCH_LIMIT)) {
      if (exceededByteLimit) {
        this.#storageReadLimitHints.set(byteLimit, Math.max(2, events.length + 1));
      } else if (
        hintedLimit !== undefined &&
        storageLimit < limit &&
        source.length === storageLimit
      ) {
        const expanded = Math.min(limit, storageLimit * 2);
        if (expanded === limit) this.#storageReadLimitHints.delete(byteLimit);
        else this.#storageReadLimitHints.set(byteLimit, expanded);
      } else if (storageLimit === limit) {
        this.#storageReadLimitHints.delete(byteLimit);
      }
    }
    if (!useFreshTail && !sourceFromStorageCache) {
      // Never pin an initial over-read. Retain at most one complete frame or
      // its fit+1 prefix (whose crossing row is itself frame-bounded).
      const boundedCrossing =
        exceededByteLimit && bytes <= byteLimit && crossingEntryByteLength <= byteLimit;
      const caches = storageReadCaches ?? [];
      if (boundedCrossing) {
        const boundedLength = events.length + 1;
        caches.unshift({
          afterOffset,
          throughOffset,
          limit: boundedLength,
          entries: source.length === boundedLength ? source : source.slice(0, boundedLength),
        });
      } else if (!exceededByteLimit && bytes <= byteLimit) {
        caches.unshift({ afterOffset, throughOffset, limit: storageLimit, entries: source });
      }
      if (caches.length > 0) {
        this.#storageReadCachesByByteLimit.set(byteLimit, caches);
      }
      const maxEntries =
        byteLimit === PUSH_DELIVERY_BATCH_BYTE_LIMIT ? MAX_PUSH_STORAGE_READ_CACHE_ENTRIES : 1;
      if (caches.length > maxEntries) caches.pop();
    }

    const durableEvents = durable ?? events;
    const durableByteLengths = durableEventByteLengths ?? eventByteLengths;
    const projectionIsComplete =
      useFreshTail || exceededByteLimit || source.length < storageLimit || storageLimit === limit;
    const cacheProjection = projectionIsComplete && bytes <= byteLimit;
    if (useFreshTail || cacheProjection) {
      // Keep canonical arrays private. Each lane still gets an isolated array,
      // while aligned raw and durable readers share both scans through slice().
      const projection: DeliveryFrameProjection = {
        afterOffset,
        throughOffset,
        limit,
        byteLimit,
        scannedEventCount: events.length,
        includesEventByteLengths: includeEventByteLengths,
        events,
        durableEvents,
        eventByteLengths,
        durableEventByteLengths: durableByteLengths,
        byteLength: bytes,
        durableByteLength: durableBytes,
        lastOffset,
        stoppedByByteLimit: exceededByteLimit,
      };
      if (useFreshTail) {
        if (includeEventByteLengths) this.#freshTailSizedProjection = projection;
        else this.#freshTailProjection = projection;
      } else {
        const projections = this.#storageReadProjectionsByByteLimit.get(byteLimit) ?? [];
        projections.unshift(projection);
        this.#storageReadProjectionsByByteLimit.set(byteLimit, projections);
        const maxEntries =
          byteLimit === PUSH_DELIVERY_BATCH_BYTE_LIMIT ? MAX_PUSH_STORAGE_READ_CACHE_ENTRIES : 1;
        if (projections.length > maxEntries) projections.pop();
      }
      return {
        events: (durableOnly ? durableEvents : events).slice(),
        scannedEventCount: events.length,
        lastOffset,
        eventByteLengths: durableOnly ? durableByteLengths : eventByteLengths,
        byteLength: durableOnly ? durableBytes : bytes,
        projection,
        durableOnly,
        stoppedByByteLimit: exceededByteLimit,
      };
    }
    return {
      events: durableOnly ? durableEvents : events,
      scannedEventCount: events.length,
      lastOffset,
      eventByteLengths: durableOnly ? durableByteLengths : eventByteLengths,
      byteLength: durableOnly ? durableBytes : bytes,
      projection: undefined,
      durableOnly,
      stoppedByByteLimit: exceededByteLimit,
    };
  }
}

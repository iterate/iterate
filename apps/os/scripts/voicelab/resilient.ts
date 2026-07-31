// Resilient wrapper around stream.openConnection() for realtime consumers.
//
// The preview bench exposed two production behaviors a voice pipe must survive:
//  1. A session connection stops carrying callback batches after ~1000-1300
//     pushes (per-connection worker subrequest budget) — delivery goes silent
//     while the socket stays "healthy" and appends keep succeeding.
//  2. A Stream DO storage reset kills every session connection with no
//     client-visible close (session connections are deliberately non-durable).
//
// Strategy: make-before-break recycling. Proactively open a successor
// connection before the push budget runs out (and reactively whenever
// delivery goes quiet while traffic is expected), keep both briefly
// overlapped, and dedupe by event offset. Ephemeral events appended while
// NO connection was live are gone forever — that loss window is what the
// watchdog minimizes and what `stats().gaps` reports.
import type { Stream, StreamConnectionHandle, StreamEventBatch } from "iterate/sdk";

/** Options for {@link openResilientConnection}. */
export interface ResilientConnectionOptions {
  /** Base connection key; generations append -g<N>. */
  connectionKey: string;
  /** Server-side event-type filter. */
  eventTypes: readonly string[];
  /** Called once per delivered batch with already-deduped events. */
  onEvents: (events: StreamEventBatch["events"], batch: StreamEventBatch) => void;
  /** Proactively recycle after this many delivered batches (stay under the ~1000-push budget). */
  recycleAfterBatches?: number;
  /** Reopen if no batch arrived for this long while trafficExpected() is true. */
  quietMs?: number;
  /** Should batches be flowing right now? (e.g. "we are appending" / "pings are in flight"). */
  trafficExpected?: () => boolean;
  /** Log lifecycle notes to stderr. */
  verbose?: boolean;
}

/** Counters describing how eventful the connection's life was. */
export interface ResilientConnectionStats {
  opens: number;
  proactiveRecycles: number;
  watchdogReopens: number;
  dedupedEvents: number;
  /** Delivery-silence gaps (ms) bridged by a watchdog reopen. */
  gapsMs: number[];
}

export interface ResilientConnection {
  close(): void;
  stats(): ResilientConnectionStats;
}

export async function openResilientConnection(
  stream: Stream,
  options: ResilientConnectionOptions,
): Promise<ResilientConnection> {
  const recycleAfterBatches = options.recycleAfterBatches ?? 700;
  const quietMs = options.quietMs ?? 2500;
  let generation = 0;
  let current: StreamConnectionHandle | null = null;
  let currentBatches = 0;
  let lastBatchAt = Date.now();
  let lastSeenOffset = -1;
  let closed = false;
  let opening = false;
  const stats: ResilientConnectionStats = {
    opens: 0,
    proactiveRecycles: 0,
    watchdogReopens: 0,
    dedupedEvents: 0,
    gapsMs: [],
  };

  const note = (message: string) => {
    if (options.verbose !== false) console.error(`resilient[${options.connectionKey}]: ${message}`);
  };

  const handleBatch = (batch: StreamEventBatch) => {
    lastBatchAt = Date.now();
    currentBatches++;
    const fresh = batch.events.filter((event) => event.offset > lastSeenOffset);
    stats.dedupedEvents += batch.events.length - fresh.length;
    if (fresh.length > 0) {
      lastSeenOffset = fresh[fresh.length - 1]!.offset;
      options.onEvents(fresh, batch);
    }
    if (currentBatches >= recycleAfterBatches && !opening && !closed) {
      stats.proactiveRecycles++;
      note(`proactive recycle after ${currentBatches} batches`);
      void reopen();
    }
  };

  const reopen = async () => {
    if (opening || closed) return;
    opening = true;
    const previous = current;
    try {
      generation++;
      // Replaying after the last seen offset re-delivers durable control-plane
      // events missed during a gap; ephemeral rows are never replayed (stale
      // audio is the right thing to lose).
      const next = await stream.openConnection({
        connectionKey: `${options.connectionKey}-g${generation}`,
        eventTypes: options.eventTypes,
        processEventBatch: handleBatch,
        ...(lastSeenOffset >= 0 ? { replayAfterOffset: lastSeenOffset } : {}),
      });
      stats.opens++;
      current = next;
      currentBatches = 0;
      lastBatchAt = Date.now();
      if (lastSeenOffset < 0) lastSeenOffset = next.streamMaxOffset;
      previous?.close();
    } catch (error) {
      note(`reopen failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      opening = false;
    }
  };

  const watchdog = setInterval(() => {
    if (closed || opening) return;
    const quietFor = Date.now() - lastBatchAt;
    if (quietFor > quietMs && (options.trafficExpected?.() ?? true)) {
      stats.watchdogReopens++;
      stats.gapsMs.push(quietFor);
      note(`delivery quiet for ${quietFor}ms — reopening`);
      void reopen();
    }
  }, 250);

  await reopen();
  if (current === null) {
    clearInterval(watchdog);
    throw new Error("initial openConnection failed");
  }

  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      current?.close();
    },
    stats: () => stats,
  };
}

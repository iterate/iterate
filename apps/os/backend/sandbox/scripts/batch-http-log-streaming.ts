export type Stream = "stdout" | "stderr";

export type LogItem<E extends string | undefined = string> = {
  seq: number;
  ts: number;
  stream: Stream;
  message: string;
  event?: E;
};

export type BatchLogStreamerOptions = {
  url: string;
  meta?: Record<string, unknown>;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

export type BatchLogStreamer<E extends string | undefined = string> = {
  enqueue: (item: { stream: Stream; message: string; event?: E; complete?: boolean }) => void;
  flush: () => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

export function createBatchLogStreamer<E extends string | undefined = string>(
  options: BatchLogStreamerOptions,
): BatchLogStreamer<E> {
  const { url, meta } = options;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;

  let seq = 0;
  let pending: LogItem<E>[] = [];
  let lastHeartbeatAt = 0;
  let isFlushing = false;
  let currentFlushPromise: Promise<void> | null = null;
  let flushTimer: NodeJS.Timeout | undefined;

  const enqueue = (item: { stream: Stream; message: string; event?: E; complete?: boolean }) => {
    seq += 1;
    pending.push({
      seq,
      ts: Date.now(),
      stream: item.stream,
      message: item.message,
      event: item.event,
    });
    if (item.complete) {
      // Flush immediately when caller signals completeness
      void flush();
    }
  };

  const flush = async () => {
    if (isFlushing && currentFlushPromise) {
      // A flush is already in progress; wait for it to drain
      await currentFlushPromise;
      return;
    }
    isFlushing = true;
    currentFlushPromise = (async () => {
      try {
        // Always send heartbeats on interval even if there are no logs
        const now = Date.now();
        if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
          try {
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(meta ?? {}), logs: [] }),
            });
            lastHeartbeatAt = now;
          } catch {
            // ignore heartbeat errors
          }
        }

        // Drain all pending batches until queue is empty.
        // New enqueues during the send loop will be picked up by reiteration.
        // Preserve order by sending the oldest enqueued first.

        while (true) {
          const batch = pending;
          if (batch.length === 0) break;
          pending = [];
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(meta ?? {}), logs: batch }),
            });
            if (!res.ok) {
              // requeue at the front to preserve order
              pending = batch.concat(pending);
              break; // avoid tight loop on repeated failures
            }
            // best-effort: read json to keep connection clean
            try {
              await res.json();
            } catch {
              // ignore parse errors
            }
          } catch {
            // put back to queue on error (front to preserve order)
            pending = batch.concat(pending);
            break;
          }
        }
      } finally {
        isFlushing = false;
        currentFlushPromise = null;
      }
    })();
    await currentFlushPromise;
  };

  const start = () => {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
  };

  const stop = async () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    await flush();
  };

  return { enqueue, flush, start, stop };
}

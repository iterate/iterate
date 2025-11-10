export type Stream = "stdout" | "stderr";

export type LogItem<E extends string | undefined = string> = {
  seq: number;
  ts: number;
  stream: Stream;
  message: string;
  event?: E;
};

export type BatchHttpFlusherOptions<E extends string | undefined = string> = {
  url: string;
  meta?: Record<string, unknown>;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

export type BatchHttpFlusher<E extends string | undefined = string> = {
  enqueue: (item: { stream: Stream; message: string; event?: E }) => void;
  flush: () => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

export function createBatchHttpFlusher<E extends string | undefined = string>(
  options: BatchHttpFlusherOptions<E>,
): BatchHttpFlusher<E> {
  const { url, meta } = options;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;

  let seq = 0;
  let pending: LogItem<E>[] = [];
  let lastHeartbeatAt = 0;
  let isFlushing = false;
  let flushTimer: NodeJS.Timeout | undefined;

  const enqueue = (item: { stream: Stream; message: string; event?: E }) => {
    seq += 1;
    pending.push({
      seq,
      ts: Date.now(),
      stream: item.stream,
      message: item.message,
      event: item.event,
    });
  };

  const flush = async () => {
    if (isFlushing) return;
    isFlushing = true;

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

    const batch = pending;
    if (batch.length === 0) {
      isFlushing = false;
      return;
    }

    // create a new pending array; new enqueues will append there while batch is in-flight
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
        isFlushing = false;
        return;
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
    } finally {
      isFlushing = false;
    }
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

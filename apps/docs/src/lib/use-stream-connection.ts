import { useEffect, useRef, useState } from "react";

/** The vessel's connection handle: the platform's `ping` and `close`, restated. */
export type StreamConnectionHandle = {
  ping?(): Promise<boolean> | boolean;
  unsubscribe(): void;
};

/**
 * What the connection reports: the two expected states, or the failure
 * message while it is down.
 */
export type StreamConnectionStatus = "connecting" | "live" | "reconnecting…" | (string & {});

/**
 * Hold one retained-callback stream connection for the component's lifetime.
 * `open` is called with the replay cursor; every batch reaches `onBatch`,
 * whose newest offset becomes the next cursor. The connection rides the
 * shared capnweb socket, and a redial elsewhere (any RPC failure disposes
 * the session) silently drops it, so the handle is heartbeated every ten
 * seconds and reopened from the last seen offset when it dies. Replay
 * overlap is the caller's to dedupe: an offset is an event's identity.
 */
export function useStreamConnection<Event extends { offset: number }>(input: {
  enabled: boolean;
  open: (
    onBatch: (events: Event[]) => void,
    afterOffset: number,
  ) => Promise<StreamConnectionHandle>;
  onBatch: (events: Event[]) => void;
}): { status: StreamConnectionStatus } {
  const [status, setStatus] = useState<StreamConnectionStatus>("connecting");
  const onBatchRef = useRef(input.onBatch);
  onBatchRef.current = input.onBatch;
  const { enabled, open } = input;

  useEffect(() => {
    if (!enabled) return;
    setStatus("connecting");
    let lastOffset = 0;
    let handle: StreamConnectionHandle | null = null;
    let cancelled = false;
    let connecting = false;

    const onBatch = (batch: Event[]) => {
      if (cancelled) return;
      setStatus("live");
      // Events only ever arrive through batches, so the highest offset seen
      // across batches IS the replay cursor.
      for (const event of batch) if (event.offset > lastOffset) lastOffset = event.offset;
      onBatchRef.current(batch);
    };

    const connect = (afterOffset: number) => {
      if (connecting) return; // single-flight — overlapping failures share one
      connecting = true;
      open(onBatch, afterOffset).then(
        (opened) => {
          connecting = false;
          if (cancelled) {
            opened.unsubscribe();
            return;
          }
          handle = opened;
          // An open handle on an empty stream is live with zero events,
          // not stuck "Connecting…".
          setStatus("live");
        },
        (cause: unknown) => {
          connecting = false;
          if (!cancelled) setStatus(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };
    connect(0);

    let pinging = false;
    const heartbeat = setInterval(() => {
      void (async () => {
        if (cancelled || pinging) return; // a slow ping owns the verdict
        if (handle === null) {
          // A failed (re)connect must keep retrying — a dead handle with no
          // retry would leave the caller reading "live" forever.
          if (!connecting) {
            setStatus("reconnecting…");
            connect(lastOffset);
          }
          return;
        }
        pinging = true;
        try {
          if ((await handle.ping?.()) === false) throw new Error("connection lapsed");
        } catch {
          if (cancelled) return;
          setStatus("reconnecting…");
          try {
            handle.unsubscribe();
          } catch {
            // the dead session is already gone
          }
          handle = null;
          connect(lastOffset);
        } finally {
          pinging = false;
        }
      })();
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      try {
        handle?.unsubscribe();
      } catch {
        // a session already torn down is fine
      }
    };
  }, [enabled, open]);

  return { status };
}

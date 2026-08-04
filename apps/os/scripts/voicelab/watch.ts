// A stream watcher that proves its own liveness, for runs measured in hours.
//
// Ephemeral events — dev-stats, every audio frame — only reach connections
// that already existed when the event was appended. So a long measurement has
// exactly one instrument, opened before anything happens, and if that
// instrument dies the run does not report an error: it reports a silent call.
// The first long soak in this lab "found" four unanswered turns in a row that
// the bridge had in fact answered. What had stopped was the watching.
//
// Hence: no delivery for `quietMs` is treated as suspicious rather than
// trusted. `ping()` then says which of the two things went quiet — the
// connection or the DEVICE — and only the first is ours to fix. Replacement is
// make-before-break, so nothing is missed across a swap.
import type { Stream, StreamEventBatch } from "iterate/node";

/** How to open, and re-open, one watching connection on a stream. */
export interface WatchStreamOptions {
  stream: Stream;
  /**
   * Stable prefix for the connection key; a generation number is appended, so
   * a replacement never collides with the connection it is replacing.
   */
  key: string;
  eventTypes: readonly string[];
  /** Called for every delivered batch, on every generation of the connection. */
  onBatch: (batch: StreamEventBatch) => void;
  /** Progress and incident narration; the caller decides where it goes. */
  onNote?: (what: string) => void;
  /**
   * Called when the connection pinged alive and yet nothing is arriving — the
   * one moment the stream cannot say what is wrong, because the thing that has
   * stopped is the publisher. Ask the device directly here.
   */
  onDeviceQuiet?: () => void;
  /** Silence that counts as suspicious. The device publishes every 5s. */
  quietMs?: number;
}

/** A live watch, and the record of everything that happened to it. */
export interface StreamWatch {
  /** Stop watching. Safe to call more than once. */
  close(): void;
  /** How often the CONNECTION had to be replaced. Not a device fault. */
  readonly reopens: number;
  /**
   * How often the connection was proven alive while nothing was arriving —
   * i.e. the DEVICE stopped publishing. That one IS a device fault.
   */
  readonly deviceQuiet: number;
}

export async function watchStream(options: WatchStreamOptions): Promise<StreamWatch> {
  const quietMs = options.quietMs ?? 15_000;
  const note = options.onNote ?? (() => {});
  let generation = 0;
  let reopens = 0;
  let deviceQuiet = 0;
  let lastDelivery = Date.now();
  let closed = false;
  /* Consecutive quiet checks survived on a connection that pinged alive. A
   * live socket carrying nothing is a device symptom the first time and a
   * reason to distrust the instrument by the third. */
  let quietStreak = 0;

  const open = () =>
    options.stream.openConnection({
      connectionKey: `${options.key}-g${++generation}`,
      eventTypes: options.eventTypes,
      processEventBatch: (batch) => {
        lastDelivery = Date.now();
        options.onBatch(batch);
      },
    });

  let connection = await open();

  const replace = () => {
    reopens++;
    lastDelivery = Date.now();
    quietStreak = 0;
    void open().then(
      (next) => {
        const previous = connection;
        connection = next;
        previous.close();
        if (closed) next.close();
      },
      (error) => note(`could not reopen the watch: ${String(error)}`),
    );
  };

  const timer = setInterval(() => {
    if (Date.now() - lastDelivery < quietMs) {
      quietStreak = 0;
      return;
    }
    void (async () => {
      let alive = false;
      try {
        alive = (await connection.ping()) === true;
      } catch {
        alive = false;
      }
      if (!alive) {
        note("watch went quiet and is dead — reopening (the watcher, not the call)");
        replace();
        return;
      }
      quietStreak++;
      deviceQuiet++;
      note(
        `nothing published for ${Math.round((Date.now() - lastDelivery) / 1000)}s — THE DEVICE is quiet, the watch is alive`,
      );
      options.onDeviceQuiet?.();
      if (quietStreak >= 3) {
        note("still quiet after three checks — replacing the watch anyway");
        replace();
      }
    })();
  }, 5000);

  return {
    close: () => {
      closed = true;
      clearInterval(timer);
      connection.close();
    },
    get deviceQuiet() {
      return deviceQuiet;
    },
    get reopens() {
      return reopens;
    },
  };
}

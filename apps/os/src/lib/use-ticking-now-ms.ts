import { useCallback, useState, useSyncExternalStore } from "react";

/**
 * A wall-clock subscribed via `useSyncExternalStore`, not `useState` +
 * `setInterval` in an effect. That keeps concurrent rendering correct and
 * matches react-doctor's prefer-use-sync-external-store guidance: the
 * snapshot is a stable scalar between ticks, and the interval only runs
 * while something is subscribed.
 */
function createTickingClock(intervalMs: number) {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function ensureTimer() {
    if (timer != null || listeners.size === 0) return;
    timer = setInterval(() => {
      now = Date.now();
      for (const listener of listeners) listener();
    }, intervalMs);
  }

  function maybeStopTimer() {
    if (timer == null || listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    subscribe(onStoreChange: () => void) {
      listeners.add(onStoreChange);
      now = Date.now();
      ensureTimer();
      // Notify after subscribe returns so a remount/re-enable re-reads
      // getSnapshot. Skip if already unsubscribed (Strict Mode remount).
      queueMicrotask(() => {
        if (listeners.has(onStoreChange)) onStoreChange();
      });
      return () => {
        listeners.delete(onStoreChange);
        maybeStopTimer();
      };
    },
    getSnapshot() {
      return now;
    },
  };
}

/** One shared clock per interval so many components do not each own a timer. */
const clocks = new Map<number, ReturnType<typeof createTickingClock>>();

function clockFor(intervalMs: number) {
  let clock = clocks.get(intervalMs);
  if (clock == null) {
    clock = createTickingClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/**
 * Live wall-clock milliseconds. Ticks every `intervalMs` while `enabled` is
 * true. When `stopAtMs` is reached, the returned value freezes at that
 * boundary and this subscriber detaches from the shared timer. When disabled,
 * returns a frozen snapshot and holds no timer.
 */
export function useTickingNowMs(
  intervalMs: number,
  enabled = true,
  stopAtMs: number | null = null,
): number {
  const clock = clockFor(intervalMs);
  const snapshot = useCallback(
    () => Math.min(clock.getSnapshot(), stopAtMs ?? Number.POSITIVE_INFINITY),
    [clock, stopAtMs],
  );
  // Server rendering never subscribes, so it needs a snapshot from this
  // render rather than the shared clock's last browser tick. A lazy immutable
  // state value is render-pure and remains Object.is-stable for hydration.
  const [initialNowMs] = useState(Date.now);
  const serverSnapshot = useCallback(
    () => Math.min(initialNowMs, stopAtMs ?? Number.POSITIVE_INFINITY),
    [initialNowMs, stopAtMs],
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      let unsubscribe = () => {};
      const notifyUntilBoundary = () => {
        onStoreChange();
        if (stopAtMs != null && clock.getSnapshot() >= stopAtMs) unsubscribe();
      };
      unsubscribe = clock.subscribe(notifyUntilBoundary);
      if (stopAtMs != null && clock.getSnapshot() >= stopAtMs) unsubscribe();
      return unsubscribe;
    },
    [clock, enabled, stopAtMs],
  );

  // The clock snapshot is mutated only by the external store. With no live
  // subscription it remains stable, so disabled consumers freeze without a
  // render-time ref write.
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

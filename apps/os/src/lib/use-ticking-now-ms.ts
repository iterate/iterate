import { useCallback, useSyncExternalStore } from "react";

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
      // Fresh snapshot so a late subscriber is not stuck on a stale `now`.
      // Notify after subscribe returns — useSyncExternalStore re-reads
      // getSnapshot on notification; updating `now` alone without notifying
      // leaves the render-time snapshot in place until the next interval tick.
      // Only fire if still registered (Strict Mode / enabled flip can
      // unsubscribe before the microtask runs).
      now = Date.now();
      ensureTimer();
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
 * true; when disabled, returns a frozen snapshot and holds no timer.
 */
export function useTickingNowMs(intervalMs: number, enabled = true): number {
  const clock = clockFor(intervalMs);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      return clock.subscribe(onStoreChange);
    },
    [clock, enabled],
  );
  return useSyncExternalStore(subscribe, clock.getSnapshot, clock.getSnapshot);
}

import { useCallback, useRef, useSyncExternalStore } from "react";

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
      // Idle clock: refresh only when wall time has moved by a full tick so
      // the first render after a long idle is current, but consecutive
      // getSnapshot calls in the same tick stay Object.is-stable (avoids
      // useSyncExternalStore infinite re-render loops).
      if (timer == null) {
        const wall = Date.now();
        if (wall - now >= intervalMs) now = wall;
      }
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
  // Stable freeze while disabled so getSnapshot does not return a fresh
  // Date.now() every call (that would infinite-loop useSyncExternalStore).
  const frozenWhileDisabledRef = useRef(Date.now());
  if (enabled) {
    frozenWhileDisabledRef.current = clock.getSnapshot();
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      return clock.subscribe(onStoreChange);
    },
    [clock, enabled],
  );

  const getSnapshot = useCallback(() => {
    if (!enabled) return frozenWhileDisabledRef.current;
    return clock.getSnapshot();
  }, [clock, enabled]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

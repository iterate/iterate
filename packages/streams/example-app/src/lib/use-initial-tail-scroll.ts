import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

const TAIL_SETTLE_MS = 250;
// Real scroll distance (in px) from the bottom of the scroller that still counts as "at the
// tail". Kept tiny on purpose: TanStack's `scrollEndThreshold` (80px) decides when *following*
// kicks in, but once appends quiesce the pin must land exactly at the bottom.
const TAIL_CONVERGED_EPSILON_PX = 2;

export type InitialTailScrollState = {
  settledInitialEndScroll: RefObject<boolean>;
  userLeftTail: RefObject<boolean>;
  markUserLeftTail(reason?: string): void;
};

/**
 * Keep the virtual list pinned to the tail while SQLite replay / bulk appends fill the mirror.
 *
 * Two invariants make this deterministic on slow machines (CI):
 * 1. The pin holds until the *user* leaves the tail — detected from input events AND from any
 *    backward scroll (scrollTop decreasing). Time-based heuristics alone are racy: a late
 *    SQLite invalidation used to re-pin the list after a programmatic scroll away, and a
 *    mid-replay stall used to release the pin while thousands of rows were still streaming in,
 *    permanently losing the tail (TanStack's followOnAppend only re-engages within
 *    scrollEndThreshold of the end).
 * 2. After each append burst the pin converges to the *actual* bottom. TanStack's
 *    followOnAppend can resolve its scroll target against a pre-commit scrollHeight and stop
 *    short by the measurement delta of newly windowed rows (estimate vs. measured height),
 *    which can exceed scrollEndThreshold and silently break the follow chain.
 *
 * `settledInitialEndScroll` flips once the pin has both converged and quiesced; it only gates
 * the unread-badge suppression, never the pin itself.
 */
export function useInitialTailScroll<TScrollElement extends Element>(args: {
  count: number;
  scrollElementRef: RefObject<TScrollElement | null>;
  virtualizer: Virtualizer<TScrollElement, Element>;
}): InitialTailScrollState {
  const settledInitialEndScroll = useRef(false);
  const userLeftTail = useRef(false);
  const tailSettleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(args);
  latest.current = args;

  function markUserLeftTail(reason: string = "explicit", detail: Record<string, number> = {}) {
    if (!userLeftTail.current) {
      // Deliberate breadcrumb: tail-pin releases are the prime suspect whenever the
      // virtualized stream e2e specs strand the viewport mid-list, and Playwright traces
      // capture console output. Logged once, on the release transition only.
      console.debug(`[initial-tail-scroll] pin released: ${reason}`, JSON.stringify(detail));
    }
    userLeftTail.current = true;
  }

  useEffect(() => {
    const element = args.scrollElementRef.current;
    if (element === null) return;
    const onUserScroll = (event: Event) => {
      markUserLeftTail(`user-input:${event.type}`);
    };
    // Any scroll that moves *away* from the tail means the viewport intentionally left it.
    // This catches scrolls that produce no input event (scrollbar drags mid-gesture,
    // programmatic scrollTop writes from tests or other code). "Away from the tail" requires
    // BOTH a scrollTop decrease and a distance-from-end increase: appends grow scrollHeight
    // without touching scrollTop, and TanStack's above-viewport resize adjustments move
    // scrollTop and scrollHeight together, so neither trips this.
    let lastScrollTop = element.scrollTop;
    let lastDistanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    const onScroll = () => {
      const nextScrollTop = element.scrollTop;
      const nextDistanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (
        nextScrollTop < lastScrollTop - TAIL_CONVERGED_EPSILON_PX &&
        nextDistanceFromEnd > lastDistanceFromEnd + TAIL_CONVERGED_EPSILON_PX
      ) {
        markUserLeftTail("scroll-away", {
          lastScrollTop,
          nextScrollTop,
          lastDistanceFromEnd,
          nextDistanceFromEnd,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        });
      }
      lastScrollTop = nextScrollTop;
      lastDistanceFromEnd = nextDistanceFromEnd;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onUserScroll, { passive: true });
    element.addEventListener("pointerdown", onUserScroll);
    element.addEventListener("touchmove", onUserScroll, { passive: true });
    element.addEventListener("keydown", onUserScroll);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onUserScroll);
      element.removeEventListener("pointerdown", onUserScroll);
      element.removeEventListener("touchmove", onUserScroll);
      element.removeEventListener("keydown", onUserScroll);
    };
  }, [args.scrollElementRef]);

  function realDistanceFromEnd() {
    const element = latest.current.scrollElementRef.current;
    if (element === null) return 0;
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  }

  function clearTailSettleTimer() {
    if (tailSettleTimer.current === undefined) return;
    clearTimeout(tailSettleTimer.current);
    tailSettleTimer.current = undefined;
  }

  function armTailSettleTimer() {
    clearTailSettleTimer();
    tailSettleTimer.current = setTimeout(() => {
      tailSettleTimer.current = undefined;
      if (userLeftTail.current) return;
      if (realDistanceFromEnd() > TAIL_CONVERGED_EPSILON_PX) {
        // Not at the actual bottom yet (late measurements, a follow that resolved against a
        // stale scrollHeight, or rows still streaming in): keep pinning until converged.
        latest.current.virtualizer.scrollToEnd();
        armTailSettleTimer();
        return;
      }
      if (!settledInitialEndScroll.current) {
        console.debug(
          `[initial-tail-scroll] pin settled`,
          JSON.stringify({ count: latest.current.count, distanceFromEnd: realDistanceFromEnd() }),
        );
      }
      settledInitialEndScroll.current = true;
    }, TAIL_SETTLE_MS);
  }

  useLayoutEffect(() => {
    if (args.count === 0 || userLeftTail.current) return;
    args.virtualizer.scrollToEnd();
    requestAnimationFrame(() => {
      if (userLeftTail.current) return;
      args.virtualizer.scrollToEnd();
    });
    armTailSettleTimer();
  }, [args.count, args.virtualizer]);

  // Clear the (self-re-arming) settle timer on unmount only; per-render cleanup would race
  // with the convergence loop between count changes.
  useEffect(() => clearTailSettleTimer, []);

  return { settledInitialEndScroll, userLeftTail, markUserLeftTail };
}

export function shouldSuppressUnreadBadgeDuringInitialTail(args: InitialTailScrollState) {
  return !args.settledInitialEndScroll.current && !args.userLeftTail.current;
}

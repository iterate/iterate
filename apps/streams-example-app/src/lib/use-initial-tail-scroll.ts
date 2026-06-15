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
 * 1. The pin holds until the *user* leaves the tail. "User left" is detected ONLY from input
 *    events (wheel/pointerdown/touchmove/keydown) or an explicit `markUserLeftTail()` call.
 *    It must NOT be inferred from scroll-position deltas: while the pin converges, TanStack's
 *    own reconcile/adjustment writes can move scrollTop *backwards* by the gap between its
 *    virtual end target and the real DOM bottom (non-virtualized chrome inside the scroller;
 *    platform font metrics make this ~12px on CI Linux vs ~0 on macOS), and scroll events
 *    coalesce that with concurrent append growth — indistinguishable from a user scrolling
 *    away. A delta heuristic stranded the viewport mid-replay in CI exactly this way (see
 *    stream-processor-class-migration-log.md, I6). Anything programmatic that intends to
 *    leave the tail (e.g. the scroll-to-top button, e2e helpers) must announce itself via
 *    `markUserLeftTail()` or a synthetic input event.
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

  function markUserLeftTail(reason = "explicit") {
    if (!userLeftTail.current) {
      // Deliberate breadcrumb: tail-pin releases are the prime suspect whenever the
      // virtualized stream e2e specs strand the viewport mid-list, and Playwright traces
      // capture console output. Logged once, on the release transition only.
      console.debug(`[initial-tail-scroll] pin released: ${reason}`);
    }
    userLeftTail.current = true;
  }

  useEffect(() => {
    const element = args.scrollElementRef.current;
    if (element === null) return;
    const onUserScroll = (event: Event) => {
      markUserLeftTail(`user-input:${event.type}`);
    };
    // ONLY input events release the pin — never scroll-position deltas. See the invariant
    // comment above: the virtualizer's own convergence writes look exactly like a user
    // scrolling away once scroll events coalesce them with append growth.
    element.addEventListener("wheel", onUserScroll, { passive: true });
    element.addEventListener("pointerdown", onUserScroll);
    element.addEventListener("touchmove", onUserScroll, { passive: true });
    element.addEventListener("keydown", onUserScroll);
    return () => {
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

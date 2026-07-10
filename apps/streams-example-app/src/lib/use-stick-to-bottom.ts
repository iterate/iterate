import { useEffect, useRef, type RefObject } from "react";

// An identical copy of this hook lives in apps/os/src/lib/use-stick-to-bottom.ts —
// the two apps share no package, and the logic is deliberately the same.
// If you fix a bug here, fix it there too.

/** How close (px) to the bottom a user scroll must land to re-engage the stick. */
const RESTICK_EPSILON_PX = 2;

/**
 * Stick a scroll container to its bottom edge, Slack-style, with plain DOM
 * events — no timers, no polling.
 *
 * Why TanStack Virtual's followOnAppend/scrollToEnd aren't enough on their
 * own: they act on the virtualizer's INTERNAL offset/size model, which
 * drifts from the real DOM by small amounts while async row data settles
 * (its isAtEnd() can read true while the viewport sits a row short), and the
 * model knows nothing about elements it doesn't measure resizing — a
 * variable-height composer below the feed shrinking the viewport, or a
 * sticky composer inside the scroller growing the content, neither of which
 * fires a scroll event. This hook works exclusively in DOM truth: whenever
 * the viewport or any observed content element resizes while stuck, it
 * writes scrollTop = scrollHeight directly. The scroll event that write
 * fires is also what re-synchronizes the virtualizer's internal offset, so
 * the library's own machinery (end-anchored resize compensation for readers
 * mid-history) keeps agreeing with reality.
 *
 * Stick lifecycle: starts stuck (feeds open at the newest message). Real
 * user input on the scroller — upward wheel, touch, keydown, pointerdown
 * (scrollbar grabs and row clicks included) — releases it, so a reader in
 * history, or one who clicked a row open to read it, is never yanked. Input
 * originating inside `releaseExemptElementRef` (a composer that lives inside
 * the scroller) does NOT release: typing or clicking into the composer is
 * not leaving-the-tail intent. A user scroll that lands back at the bottom
 * re-engages the stick. Releasing on touchstart also means the hook never
 * writes scrollTop during a touch-driven fling, sidestepping WebKit's
 * dropped-write-during-momentum behavior.
 *
 * Known band: a released reader hovering within the virtualizer's
 * scrollEndThreshold (80px) of the end is still "at end" to TanStack's
 * anchorTo compensation, which holds their DISTANCE to the bottom constant
 * while the tail grows — a gentle drift, not a yank, and it converges them
 * back onto the stick at the clamp. Below RESTICK_EPSILON_PX the stick takes
 * over exactly.
 */
export function useStickToBottom({
  contentElementRefs,
  onRelease,
  releaseExemptElementRef,
  scrollElementRef,
}: {
  /**
   * Elements whose resize must re-pin the bottom: the virtualizer's sizer
   * (content growth: appends, streaming, late measurements) plus any other
   * in-scroller chrome with variable height (e.g. a sticky composer).
   */
  contentElementRefs: RefObject<HTMLElement | null>[];
  /** Called once per release, on the user input that broke the stick. */
  onRelease?: () => void;
  /** User input originating inside this element does not release the stick. */
  releaseExemptElementRef?: RefObject<HTMLElement | null>;
  scrollElementRef: RefObject<HTMLElement | null>;
}): {
  /** Live view of the stick state (a ref — reads are always current). */
  stuckRef: RefObject<boolean>;
  /** Programmatic release for controls outside the scroller (e.g. a scroll-to-top button). */
  release: (reason?: string) => void;
} {
  const stuck = useRef(true);
  const latestOnRelease = useRef(onRelease);
  latestOnRelease.current = onRelease;

  const releaseRef = useRef((reason = "explicit") => {
    if (!stuck.current) return;
    // Deliberate breadcrumb: stick releases are the prime suspect whenever a
    // virtualized feed spec strands the viewport mid-list, and Playwright
    // traces capture console output. Logged on the release transition only.
    console.debug(`[stick-to-bottom] released: ${reason}`);
    stuck.current = false;
    latestOnRelease.current?.();
  });

  // The ref contents are stable for the component's lifetime; splitting them
  // out of the deps keeps the single effect from re-subscribing per render.
  const latestRefs = useRef({ contentElementRefs, releaseExemptElementRef });
  latestRefs.current = { contentElementRefs, releaseExemptElementRef };
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const scroller = scrollElementRef.current;
    if (scroller == null) return;
    const release = releaseRef.current;

    const restick = () => {
      if (!stuck.current) return;
      // Direct DOM write, not virtualizer.scrollToEnd(): the target is the
      // real bottom by definition, and this never arms the library's
      // multi-frame scroll-reconcile loop (which is uncancellable and can
      // fight a user who grabs the wheel mid-flight).
      scroller.scrollTop = scroller.scrollHeight;
    };

    // Fires once per observe (the initial open-at-bottom scroll), then on
    // every observed resize — content growth from appends/streaming/late
    // measurements, viewport changes, composer growth.
    const resizeObserver = new ResizeObserver(restick);
    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(scroller);
    for (const ref of latestRefs.current.contentElementRefs) {
      if (ref.current != null) resizeObserver.observe(ref.current);
    }

    const exempt = (event: Event) => {
      const exemptElement = latestRefs.current.releaseExemptElementRef?.current;
      return (
        exemptElement != null &&
        event.target instanceof Node &&
        exemptElement.contains(event.target)
      );
    };
    const releaseFromInput = (event: Event) => {
      if (!exempt(event)) release(`user-input:${event.type}`);
    };
    // Only an UPWARD wheel is leaving-the-tail intent; wheeling down while
    // already at the bottom would otherwise release into a dead state where
    // the next append writes nothing and no scroll event fires to re-stick.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) releaseFromInput(event);
    };
    const onScroll = () => {
      if (stuck.current) return;
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (distance <= RESTICK_EPSILON_PX) stuck.current = true;
    };

    const releaseEvents = ["touchstart", "keydown", "pointerdown"] as const;
    for (const name of releaseEvents) {
      scroller.addEventListener(name, releaseFromInput, { passive: true });
    }
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      for (const name of releaseEvents) scroller.removeEventListener(name, releaseFromInput);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollElementRef]);

  // Content elements can mount LATE — e.g. a virtual container behind an
  // empty-state conditional appears only once the first rows arrive. Observe
  // whatever exists after every render; observe() on an already-observed
  // target is a spec'd no-op, so this is idempotent and cheap.
  useEffect(() => {
    const resizeObserver = resizeObserverRef.current;
    if (resizeObserver == null) return;
    for (const ref of latestRefs.current.contentElementRefs) {
      if (ref.current != null) resizeObserver.observe(ref.current);
    }
  });

  return { stuckRef: stuck, release: releaseRef.current };
}

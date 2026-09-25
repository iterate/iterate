// Stick the feed's scroll container to its bottom edge, Slack-style, with plain DOM events — no
// timers, no polling. Ported from the old platform's feed (apps/os `lib/use-stick-to-bottom.ts`,
// removed in #2837), where its failure modes were tuned (#1847/#1848).
//
// Why not TanStack Virtual's followOnAppend/scrollToEnd: they act on the virtualizer's INTERNAL
// offset/size model, which drifts from the real DOM by small amounts while rows settle (its
// isAtEnd() can read true while the viewport sits a row short), and knows nothing of a viewport
// that resizes without a scroll event. This works in DOM truth: whenever the viewport or the
// content resizes while stuck, it writes scrollTop = scrollHeight. The scroll event that write fires
// also re-synchronises the virtualizer's offset, so its own end-anchored compensation for a reader
// mid-history keeps agreeing with reality.
//
// Lifecycle: starts stuck (the feed opens at the newest event). Real user input on the scroller —
// an upward wheel, a touch, a key, a pointer down (a scrollbar grab, a row click) — releases it, so a
// reader in history, or one who clicked a row open, is never yanked. A user scroll that lands back
// at the bottom re-engages it. Releasing on touchstart also means it never writes scrollTop during a
// touch fling (WebKit drops writes during momentum). `stick()` re-engages it from outside — the
// view's own append, which the person wants to see land wherever they were reading.
import { useCallback, useEffect, useRef, type RefObject } from "react";

/** How close (px) to the bottom a user scroll must land to re-engage the stick. */
const RESTICK_EPSILON_PX = 2;

export function useStickToBottom({
  scrollElementRef,
  contentElementRef,
}: {
  scrollElementRef: RefObject<HTMLElement | null>;
  /** The virtualizer's sizer: its resize (appends, late measurements) re-pins the bottom. It may
   *  mount after the scroller (behind an empty state), so it is observed after every render. */
  contentElementRef: RefObject<HTMLElement | null>;
}): { stuckRef: RefObject<boolean>; stick: () => void } {
  const stuck = useRef(true);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const scroller = scrollElementRef.current;
    if (!scroller) return;
    const restick = () => {
      // a direct DOM write, not virtualizer.scrollToEnd(): the target is the real bottom by
      // definition, and this never arms the library's uncancellable multi-frame reconcile loop
      if (stuck.current) scroller.scrollTop = scroller.scrollHeight;
    };
    // fires once per observe (the opening scroll to the bottom), then on every observed resize
    const resizeObserver = new ResizeObserver(restick);
    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(scroller);
    if (contentElementRef.current) resizeObserver.observe(contentElementRef.current);
    const release = (event: Event) => {
      if (!stuck.current) return;
      // a breadcrumb: a released stick is the first suspect when a feed strands mid-history
      console.debug(`[stick-to-bottom] released: user-input:${event.type}`);
      stuck.current = false;
    };
    // only an UPWARD wheel leaves the tail: wheeling down at the bottom would release into a dead
    // state where the next append writes nothing and no scroll event fires to re-stick
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release(event);
    };
    const onScroll = () => {
      if (stuck.current) return;
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (distance <= RESTICK_EPSILON_PX) stuck.current = true;
    };
    const releaseEvents = ["touchstart", "keydown", "pointerdown"] as const;
    for (const name of releaseEvents) scroller.addEventListener(name, release, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      for (const name of releaseEvents) scroller.removeEventListener(name, release);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollElementRef, contentElementRef]);

  // observe() on an already-observed target is a spec'd no-op, so this is idempotent and cheap
  useEffect(() => {
    if (contentElementRef.current) resizeObserverRef.current?.observe(contentElementRef.current);
  });

  const stick = useCallback(() => {
    stuck.current = true;
    const scroller = scrollElementRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [scrollElementRef]);

  return { stuckRef: stuck, stick };
}

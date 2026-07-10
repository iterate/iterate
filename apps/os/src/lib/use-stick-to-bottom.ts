import { useEffect, useRef, type RefObject } from "react";

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
 * model knows nothing about the scroll element itself resizing — e.g. the
 * composer below the feed growing a line, which shrinks the feed viewport
 * without firing any scroll event. This hook works exclusively in DOM truth:
 * whenever the CONTENT or the VIEWPORT resizes while stuck, it writes
 * scrollTop = scrollHeight directly. The scroll event that write fires is
 * also what re-synchronizes the virtualizer's internal offset, so the
 * library's own tail machinery (append follows for near-bottom readers,
 * end-anchored resize compensation) keeps agreeing with reality.
 *
 * Stick lifecycle: starts stuck (feeds open at the newest message). Real
 * user input on the scroller — wheel, touch, keydown, pointerdown (scrollbar
 * grabs and row clicks included) — releases it, so a reader in history, or
 * one who clicked a row open to read it, is never yanked. A user scroll that
 * lands back at the bottom re-engages it.
 */
export function useStickToBottom({
  contentElementRef,
  onRelease,
  scrollElementRef,
}: {
  /** The sizer element whose height tracks the (virtualized) content. */
  contentElementRef: RefObject<HTMLElement | null>;
  /** Called once per release, on the user input that broke the stick. */
  onRelease?: () => void;
  scrollElementRef: RefObject<HTMLElement | null>;
}): RefObject<boolean> {
  const stuck = useRef(true);
  const latestOnRelease = useRef(onRelease);
  latestOnRelease.current = onRelease;

  useEffect(() => {
    const scroller = scrollElementRef.current;
    const content = contentElementRef.current;
    if (scroller == null || content == null) return;

    const restick = () => {
      if (!stuck.current) return;
      // Direct DOM write, not virtualizer.scrollToEnd(): the target is the
      // real bottom by definition, and this never arms the library's
      // multi-frame scroll-reconcile loop (which is uncancellable and can
      // fight a user who grabs the wheel mid-flight).
      scroller.scrollTop = scroller.scrollHeight;
    };

    // Fires once on observe (the initial open-at-bottom scroll), then on
    // every content growth — appends, skeleton→content swaps, late
    // measurements — and every viewport change (composer growing/shrinking).
    const resizeObserver = new ResizeObserver(restick);
    resizeObserver.observe(scroller);
    resizeObserver.observe(content);

    const release = () => {
      if (!stuck.current) return;
      stuck.current = false;
      latestOnRelease.current?.();
    };
    const onScroll = () => {
      if (stuck.current) return;
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (distance <= RESTICK_EPSILON_PX) stuck.current = true;
    };

    const releaseEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of releaseEvents) scroller.addEventListener(name, release, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resizeObserver.disconnect();
      for (const name of releaseEvents) scroller.removeEventListener(name, release);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollElementRef, contentElementRef]);

  return stuck;
}

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

const TAIL_SETTLE_MS = 250;
const TAIL_EPSILON_PX = 2;
const TAIL_STABLE_PASSES = 8;

export function useVirtualizedTailScroll<TScrollElement extends HTMLElement>(args: {
  contentSignature?: string | number;
  count: number;
  resetKey: unknown;
  scrollElementRef: RefObject<TScrollElement | null>;
  virtualizer: Virtualizer<TScrollElement, Element>;
}) {
  const userLeftTailRef = useRef(false);
  const stablePassesRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestRef = useRef(args);
  latestRef.current = args;

  function clearSettleTimer() {
    if (settleTimerRef.current === undefined) return;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = undefined;
  }

  function distanceFromBottom() {
    const element = latestRef.current.scrollElementRef.current;
    if (element == null) return 0;
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  }

  function scrollToTail() {
    latestRef.current.virtualizer.scrollToEnd();
    const element = latestRef.current.scrollElementRef.current;
    if (element == null) return;
    element.scrollTop = element.scrollHeight;
  }

  function armSettleTimer() {
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = undefined;
      if (userLeftTailRef.current) return;
      if (distanceFromBottom() > TAIL_EPSILON_PX) {
        stablePassesRef.current = 0;
        scrollToTail();
        armSettleTimer();
        return;
      }
      stablePassesRef.current += 1;
      if (stablePassesRef.current < TAIL_STABLE_PASSES) armSettleTimer();
    }, TAIL_SETTLE_MS);
  }

  useEffect(() => {
    const element = args.scrollElementRef.current;
    if (element == null) return;
    const markLeftTail = () => {
      userLeftTailRef.current = true;
      clearSettleTimer();
    };
    const onScroll = () => {
      const isAwayFromTail = distanceFromBottom() > TAIL_EPSILON_PX;
      userLeftTailRef.current = isAwayFromTail;
      if (isAwayFromTail) clearSettleTimer();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", markLeftTail, { passive: true });
    element.addEventListener("pointerdown", markLeftTail);
    element.addEventListener("touchmove", markLeftTail, { passive: true });
    element.addEventListener("keydown", markLeftTail);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", markLeftTail);
      element.removeEventListener("pointerdown", markLeftTail);
      element.removeEventListener("touchmove", markLeftTail);
      element.removeEventListener("keydown", markLeftTail);
    };
  }, [args.scrollElementRef]);

  useLayoutEffect(() => {
    userLeftTailRef.current = false;
    stablePassesRef.current = 0;
    if (args.count === 0) return;
    scrollToTail();
    armSettleTimer();
    const frame = window.requestAnimationFrame(() => {
      scrollToTail();
      armSettleTimer();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [args.resetKey, args.virtualizer]);

  useLayoutEffect(() => {
    if (args.count === 0 || userLeftTailRef.current) return;
    scrollToTail();
    armSettleTimer();
  }, [args.count, args.contentSignature, args.virtualizer]);

  useEffect(() => clearSettleTimer, []);
}

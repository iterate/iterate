import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

const INITIAL_TAIL_SETTLE_MS = 250;

export type InitialTailScrollState = {
  settledInitialEndScroll: RefObject<boolean>;
  userLeftTail: RefObject<boolean>;
  markUserLeftTail(): void;
};

/** Keep the virtual list pinned to the tail while SQLite replay fills the mirror. */
export function useInitialTailScroll<TScrollElement extends Element>(args: {
  count: number;
  scrollElementRef: RefObject<TScrollElement | null>;
  virtualizer: Virtualizer<TScrollElement, Element>;
}): InitialTailScrollState {
  const settledInitialEndScroll = useRef(false);
  const userLeftTail = useRef(false);
  const tailSettleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function markUserLeftTail() {
    userLeftTail.current = true;
  }

  useEffect(() => {
    const element = args.scrollElementRef.current;
    if (element === null) return;
    const onUserScroll = () => {
      markUserLeftTail();
    };
    element.addEventListener("wheel", onUserScroll, { passive: true });
    element.addEventListener("touchmove", onUserScroll, { passive: true });
    return () => {
      element.removeEventListener("wheel", onUserScroll);
      element.removeEventListener("touchmove", onUserScroll);
    };
  }, [args.scrollElementRef]);

  useLayoutEffect(() => {
    if (args.count === 0) return;

    if (!settledInitialEndScroll.current && !userLeftTail.current) {
      args.virtualizer.scrollToEnd();
      requestAnimationFrame(() => {
        args.virtualizer.scrollToEnd();
      });
    }

    if (settledInitialEndScroll.current) return;

    if (tailSettleTimer.current !== undefined) clearTimeout(tailSettleTimer.current);
    tailSettleTimer.current = setTimeout(() => {
      settledInitialEndScroll.current = true;
      tailSettleTimer.current = undefined;
    }, INITIAL_TAIL_SETTLE_MS);

    return () => {
      if (tailSettleTimer.current === undefined) return;
      clearTimeout(tailSettleTimer.current);
      tailSettleTimer.current = undefined;
    };
  }, [args.count, args.virtualizer]);

  return { settledInitialEndScroll, userLeftTail, markUserLeftTail };
}

export function shouldSuppressUnreadBadgeDuringInitialTail(args: InitialTailScrollState) {
  return !args.settledInitialEndScroll.current && !args.userLeftTail.current;
}

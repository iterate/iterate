import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

const INITIAL_TAIL_SETTLE_MS = 250;

/** Keep the virtual list pinned to the tail while SQLite replay fills the mirror. */
export function useInitialTailScroll<TScrollElement extends Element>(args: {
  count: number;
  virtualizer: Virtualizer<TScrollElement, Element>;
}): RefObject<boolean> {
  const settledInitialEndScroll = useRef(false);
  const tailSettleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (args.count === 0) return;

    args.virtualizer.scrollToEnd();
    requestAnimationFrame(() => {
      args.virtualizer.scrollToEnd();
    });

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

  return settledInitialEndScroll;
}

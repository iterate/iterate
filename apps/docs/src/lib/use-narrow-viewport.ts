import { useSyncExternalStore } from "react";

const NARROW_VIEWPORT = "(max-width: 1023px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_VIEWPORT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether the page is below Tailwind's `lg` breakpoint, where the side column
 * is a drawer instead of an aside. The server render answers false: the
 * aside's CSS decides what is visible there, and only one of the two mounts
 * exists once hydrated.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_VIEWPORT).matches,
    () => false,
  );
}

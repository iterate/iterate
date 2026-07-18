import type { ReactNode } from "react";

/**
 * A hard mount boundary for expensive secondary UI. Keeping this component
 * deliberately small makes the invariant easy to test: a closed surface does
 * not merely hide its work; it does not mount it at all.
 */
export function DeferredSurface({ active, children }: { active: boolean; children: ReactNode }) {
  return active ? children : null;
}

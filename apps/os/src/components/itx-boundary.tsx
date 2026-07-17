import { type ReactNode } from "react";

/** The muted-text placeholder the labelled connect/first-read waits render. */
function ItxPending({ children }: { children: ReactNode }) {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      {children}
    </div>
  );
}

/**
 * A labelled "Loading X…" Suspense fallback for the project layout / collect-
 * secret mounts, which want to name what they're waiting for. Ordinary project
 * pages need NO explicit boundary: TanStack Router already wraps every route
 * match in `<Suspense>` with the router's `defaultPendingComponent` (see
 * router.tsx), so a page that suspends on `useItxQuery` shows that fallback.
 */
export function ItxResourceLoading({ label }: { label: string }) {
  return <ItxPending>Loading {label}…</ItxPending>;
}

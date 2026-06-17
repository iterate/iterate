import { Suspense, type ReactNode } from "react";

/** The one muted-text placeholder both the socket-connect and first-read waits render. */
function ItxPending({ children }: { children: ReactNode }) {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      {children}
    </div>
  );
}

/** Suspense wrapper shared by every route that reads through itx. */
export function ItxBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ItxPending>Connecting to itx…</ItxPending>}>{children}</Suspense>;
}

/**
 * A labelled "Loading X…" Suspense fallback — used where a route suspends on a
 * specific itx read (e.g. the project layout connecting + first read) and wants
 * to name what it's waiting for rather than show the bare "Connecting to itx…".
 */
export function ItxResourceLoading({ label }: { label: string }) {
  return <ItxPending>Loading {label}…</ItxPending>;
}

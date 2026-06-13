import { Suspense, type ReactNode } from "react";
import { Button } from "@iterate-com/ui/components/button";

/** The one muted-text placeholder both the socket-connect and first-read waits render. */
function ItxPending({ children }: { children: ReactNode }) {
  return <div className="p-4 text-sm text-muted-foreground">{children}</div>;
}

/** Suspense wrapper shared by every route that reads through itx. */
export function ItxBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ItxPending>Connecting to itx…</ItxPending>}>{children}</Suspense>;
}

/**
 * The shared "Loading X…" placeholder for the useItxResource `loading` state —
 * the socket is connected (past ItxBoundary) but the first read is still in
 * flight, so routes must show this rather than flashing an empty/"none" state.
 */
export function ItxResourceLoading({ label }: { label: string }) {
  return <ItxPending>Loading {label}…</ItxPending>;
}

/** The shared "Couldn't load X — {error.message} [Retry]" panel for useItxResource routes. */
export function ItxResourceError({
  label,
  error,
  onRetry,
}: {
  label: string;
  error?: Error;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 p-4 text-sm text-muted-foreground">
      <span>
        Couldn't load {label}. {error?.message}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

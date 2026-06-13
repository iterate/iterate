import { Suspense, type ReactNode } from "react";
import { Button } from "@iterate-com/ui/components/button";

/** The single "Connecting to itx..." fallback every itx route suspends behind. */
function ItxConnecting() {
  return <div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>;
}

/** Suspense wrapper shared by every route that reads through itx. */
export function ItxBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ItxConnecting />}>{children}</Suspense>;
}

/**
 * The shared "Loading X…" placeholder for the useItxResource `loading` state —
 * the socket is connected (past ItxBoundary) but the first read is still in
 * flight, so routes must show this rather than flashing an empty/"none" state.
 */
export function ItxResourceLoading({ label }: { label: string }) {
  return <div className="p-4 text-sm text-muted-foreground">Loading {label}…</div>;
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

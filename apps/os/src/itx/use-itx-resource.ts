// The ONE client-side read hook over itx: a route hands it an async `load`
// (typically a chain of itx calls) and gets back a small { status, data,
// error, refetch } resource. No react-query, no machinery — just
// useState/useEffect/useRef — so the FE has a single, legible read shape.
//
// Two deliberate choices:
//   - `loadRef` keeps the latest `load` closure, so a re-render with a fresh
//     closure (the common case for inline `() => itx.x.y()`) does not need to
//     be in `deps` and never reads a stale closure. Callers list only their
//     real inputs (ids, filters) in `deps`.
//   - an explicit "error" status (plus the stored `error`) so callers can
//     tell empty-vs-error apart, and the hook toasts the error once.

import { useEffect, useRef, useState } from "react";
import { toast } from "@iterate-com/ui/components/sonner";

export type ItxResource<T> = {
  status: "loading" | "ready" | "error";
  data: T | undefined;
  error?: Error;
  refetch: () => Promise<void>;
};

export function useItxResource<T>({
  load,
  deps,
}: {
  load: () => Promise<T>;
  deps: unknown[];
}): ItxResource<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  // The last error message we toasted, so a refetch/poll that keeps failing
  // with the SAME error toasts once, not on every run (settings.tsx polls
  // refetch every 5s — without this it would spew a toast every 5 seconds).
  const lastToastRef = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{ status: ItxResource<T>["status"]; data?: T; error?: Error }>(
    {
      status: "loading",
    },
  );

  const run = async (isCancelled: () => boolean) => {
    try {
      const data = await loadRef.current();
      if (isCancelled()) return;
      lastToastRef.current = undefined;
      setState({ status: "ready", data });
    } catch (caught) {
      if (isCancelled()) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      setState({ status: "error", error });
      if (lastToastRef.current !== error.message) {
        lastToastRef.current = error.message;
        toast.error(error.message);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    // New resource (deps changed) → clean dedup slate, so a same-message error
    // on a DIFFERENT resource still toasts (otherwise it would be swallowed —
    // and settings.tsx, the one toast-only call site, would fail silently).
    lastToastRef.current = undefined;
    setState((prev) => ({ ...prev, status: "loading" }));
    void run(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's declared inputs; `load` is read fresh via loadRef.
  }, deps);

  // refetch never cancels: it always reflects its own latest run.
  const refetch = () => run(() => false);

  return { status: state.status, data: state.data, error: state.error, refetch };
}

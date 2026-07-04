import { useEffect, useState } from "react";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import type {
  StreamBrowserStore,
  StreamRuntimeState,
} from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { Centered } from "~/components/centered.tsx";

const STATE_POLL_INTERVAL_MS = 1_000;

/**
 * The stream view's State tab: the server-side reduced + runtime processor
 * state, polled over the store's `runtimeState()` RPC. Polling (not a push
 * subscription) is deliberate — this is a debugging surface for the server's
 * view of the stream, so it must not depend on the push channel it is often
 * used to diagnose.
 */
export function StreamStateView({ store }: { store: StreamBrowserStore }) {
  const [runtimeState, setRuntimeState] = useState<StreamRuntimeState | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const state = await store.runtimeState();
        if (!disposed) {
          // Keep the previous object identity when nothing changed so the
          // code block doesn't rebuild (and lose scroll) every poll tick.
          setRuntimeState((previous) =>
            previous != null && JSON.stringify(previous) === JSON.stringify(state)
              ? previous
              : state,
          );
          setError(undefined);
        }
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!disposed) timer = setTimeout(() => void poll(), STATE_POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [store]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <span className="text-xs font-semibold text-muted-foreground">Reduced processor state</span>
        <output className="font-mono text-xs text-muted-foreground">
          {runtimeState == null ? "loading" : "live"}
        </output>
      </div>
      {error == null ? null : (
        <p className="px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {runtimeState == null ? (
          <Centered>Reading runtime state…</Centered>
        ) : (
          <SerializedObjectCodeBlock data={runtimeState} />
        )}
      </div>
    </div>
  );
}

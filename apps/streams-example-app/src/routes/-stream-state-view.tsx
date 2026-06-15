// The "state" sibling view: the stream's reduced + runtime state, read live via the
// runtimeState() RPC. No browser processor and no SQLite table.

import { useEffect, useState } from "react";
import type { StreamViewSearch } from "../lib/stream-view-search.ts";
import { streamRpcPath, withStreamConnectionFromBrowser } from "../lib/stream-rpc.ts";

const POLL_INTERVAL_MS = 1_000;

export function StreamStateView({ streamView }: { streamView: StreamViewSearch }) {
  const [status, setStatus] = useState("connecting");
  const [stateText, setStateText] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connection: Awaited<ReturnType<typeof withStreamConnectionFromBrowser>> | undefined;

    void (async () => {
      try {
        connection = await withStreamConnectionFromBrowser({
          url: new URL(
            streamRpcPath({ path: streamView.path, namespace: streamView.namespace }),
            window.location.href,
          ),
          onConnectionStatusChange: (next) => {
            if (!disposed) setStatus(next);
          },
        });
      } catch (caught) {
        if (!disposed) setError(errorMessage(caught));
        return;
      }

      const poll = async () => {
        if (disposed || connection === undefined) return;
        try {
          const runtimeState = await connection.stream.runtimeState();
          if (!disposed) {
            setStateText(JSON.stringify(runtimeState, null, 2));
            setError(undefined);
          }
        } catch (caught) {
          if (!disposed) setError(errorMessage(caught));
        }
        if (!disposed) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      await poll();
    })();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      connection?.[Symbol.dispose]();
    };
  }, [streamView.namespace, streamView.path]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Stream state"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-white pr-4 [scrollbar-color:rgb(22_24_29_/_12%)_transparent] [scrollbar-gutter:stable_both-edges] [scrollbar-width:thin]"
      >
        <div className="sticky top-0 z-3 grid min-h-11 flex-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#eef1f5] bg-white/95 pr-4 backdrop-blur-sm">
          <span className="text-xs font-semibold text-[#667085]">Runtime state</span>
          <output
            className="whitespace-nowrap font-mono text-xs text-[#667085]"
            data-testid="connection-status"
          >
            {status}
          </output>
        </div>
        {error !== undefined ? (
          <p
            className="border-b border-[#fecdca] bg-[#fff4f2] px-2.5 py-2 text-xs text-[#912018]"
            data-testid="stream-state-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <pre
          data-testid="stream-state"
          className="m-0 flex-1 whitespace-pre-wrap break-words p-2.5 font-mono text-[13px] leading-normal text-[#536073]"
        >
          {stateText ?? "loading…"}
        </pre>
      </section>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

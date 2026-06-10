// The browser itx REPL: a Cap'n Web session straight from the browser tab to
// /api/itx, with `itx` in scope. Because itx is symmetric, anything you can
// do here you can do from Node, a worker cap, or the config worker — and the
// browser can PROVIDE live capabilities too (see the examples).

import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import {
  BROWSER_REPL_EXAMPLES,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/itx/browser-repl.ts";
import type { Itx } from "~/itx/handle.ts";
import { ItxRepl } from "~/components/itx-repl.tsx";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ItxReplPage,
});

export type BrowserReplSession = {
  close(): void;
  itx: RpcStub<Itx>;
};

export type BrowserReplSessionFactory = () => BrowserReplSession | Promise<BrowserReplSession>;

/**
 * Connect to a context: the global one by default, or a project's.
 *
 * Deliberately NOT the app's shared itx client (~/itx/react): the repl
 * disposes and recreates its session on its own schedule, which must never
 * tear down app-level queries and stream subscriptions. The cost is a second
 * itx socket on pages that show both — converging them is follow-up work.
 */
export function createBrowserReplSession(context?: string): BrowserReplSession {
  const wsUrl = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    window.location.href,
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl);
  const rpc = newWebSocketRpcSession<Itx>(socket);

  return {
    itx: rpc,
    close() {
      rpc[Symbol.dispose]?.();
      socket.close();
    },
  };
}

export function ItxReplPage({
  // NOTE: must be a STABLE reference, not an inline arrow. The connect effect
  // below depends on `connectSession`; a fresh identity each render would tear
  // down and re-create the Cap'n Web session on every render — including the
  // re-render triggered by clicking Run — disposing the stub mid-call
  // ("RPC stub used after disposed"). createBrowserReplSession() with no arg
  // connects to the global context; project repls pass their own memoized one.
  connectSession = createBrowserReplSession,
  initialCode = DEFAULT_BROWSER_REPL_CODE,
  scope,
}: {
  connectSession?: BrowserReplSessionFactory;
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const [code, setCode] = useState(initialCode);
  const [itx, setItx] = useState<RpcStub<Itx> | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [entries, setEntries] = useState<BrowserReplEntry[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [selectAllSignal, setSelectAllSignal] = useState(0);
  const envRef = useRef<Record<string, unknown>>({});
  const scopeRef = useRef<Record<string, unknown>>({ RpcTarget, ...scope });
  // Keep the scope in sync when navigating between project repls (same route, new params).
  scopeRef.current = { RpcTarget, ...scope };

  useEffect(() => {
    const globals = globalThis as typeof globalThis & {
      itx?: RpcStub<Itx>;
      env?: object;
    };
    let closed = false;
    let session: BrowserReplSession | null = null;

    void Promise.resolve(connectSession())
      .then((connectedSession) => {
        if (closed) {
          connectedSession.close();
          return;
        }

        session = connectedSession;
        globals.itx = connectedSession.itx;
        globals.env = envRef.current;
        setItx(() => connectedSession.itx);
        setStatus("Connected");
      })
      .catch((error: unknown) => {
        if (closed) return;
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => {
      closed = true;
      delete globals.itx;
      delete globals.env;
      session?.close();
    };
  }, [connectSession]);

  async function run() {
    const trimmedCode = code.trim();
    if (!itx || trimmedCode === "") return;
    setStatus("Running...");
    const entry = await runBrowserReplEntry({
      code: trimmedCode,
      env: envRef.current,
      itx,
      scope: scopeRef.current,
    });
    setEntries((current) => [...current, entry]);
    setSelectAllSignal((current) => current + 1);
    setStatus("Connected");
  }

  function selectExample(exampleCode: string) {
    setCode(exampleCode);
    setExamplesOpen(false);
  }

  return (
    <ItxRepl
      canRun={Boolean(itx) && status !== "Running..." && code.trim() !== ""}
      code={code}
      entries={entries}
      examples={BROWSER_REPL_EXAMPLES}
      examplesOpen={examplesOpen}
      onChangeCode={setCode}
      onRun={() => void run()}
      onSelectExample={selectExample}
      onSetExamplesOpen={setExamplesOpen}
      selectAllSignal={selectAllSignal}
      status={status}
    />
  );
}

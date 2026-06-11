// The browser itx REPL: a Cap'n Web session straight from the browser tab to
// /api/itx, with `itx` in scope. Because itx is symmetric, anything you can
// do here you can do from Node, a worker cap, or the config worker — and the
// browser can PROVIDE live capabilities too (see the examples).

import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  browserReplExternalScopesEqual,
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import type { ItxHandle } from "~/itx/handle.ts";
import { ItxRepl } from "~/components/itx-repl.tsx";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ItxReplPage,
});

export type BrowserReplSession = {
  close(): void;
  itx: RpcStub<ItxHandle>;
};

export type BrowserReplSessionFactory = () => BrowserReplSession | Promise<BrowserReplSession>;

/**
 * Connect to a context: the global one by default, or a project's.
 *
 * Deliberately NOT the app's useItx singleton (~/itx/use-itx.ts): the repl
 * disposes and recreates its session on its own schedule (close() on every
 * connect-effect teardown), semantics the per-context singleton deliberately
 * lacks. Multiple sockets per tab are fine — see DECISIONS D21.
 */
export function createBrowserReplSession(context?: string): BrowserReplSession {
  const wsUrl = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    window.location.href,
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl);
  const rpc = newWebSocketRpcSession<ItxHandle>(socket);

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
  context = "global",
  initialCode = DEFAULT_BROWSER_REPL_CODE,
  scope,
}: {
  connectSession?: BrowserReplSessionFactory;
  context?: "global" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const [code, setCode] = useState(initialCode);
  const [itx, setItx] = useState<RpcStub<ItxHandle> | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [entries, setEntries] = useState<BrowserReplEntry[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const envRef = useRef<Record<string, unknown>>({});
  const externalScopeRef = useRef(scope);
  const scopeRef = useRef<Record<string, unknown>>(createBrowserReplScope(scope));

  // Keep injected values in sync when navigating between project repls, without
  // wiping REPL-created bindings on ordinary state updates.
  if (!browserReplExternalScopesEqual(externalScopeRef.current, scope)) {
    externalScopeRef.current = scope;
    scopeRef.current = createBrowserReplScope(scope);
  }

  useEffect(() => {
    const globals = globalThis as typeof globalThis & {
      itx?: RpcStub<ItxHandle>;
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
    setCode("");
    const entry = await runBrowserReplEntry({
      code: trimmedCode,
      env: envRef.current,
      itx,
      scope: scopeRef.current,
    });
    setEntries((current) => [...current, entry]);
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
      context={context}
      entries={entries}
      examples={ITX_EXAMPLES}
      examplesOpen={examplesOpen}
      onChangeCode={setCode}
      onRun={() => void run()}
      onSelectExample={selectExample}
      onSetExamplesOpen={setExamplesOpen}
      status={status}
    />
  );
}

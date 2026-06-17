// The browser itx REPL: a Cap'n Web session straight from the browser tab to
// /api/itx, with `itx` in scope. Because itx is symmetric, anything you can
// do here you can do from Node, a worker cap, or the project worker — and the
// browser can PROVIDE live capabilities too (see the examples).
//
// The REPL rides the ONE browser itx primitive — useItx (~/itx/itx-react.tsx).
// It does NOT open its own socket: the global repl shares the tab's global
// socket, the project repl shares that project's socket, and neither owns the
// connection. ConnectedItxRepl is the single connect wrapper both routes use.
// See the itx-react.tsx header for the single-socket-per-context model and the
// disposal contract.

import { Suspense, useEffect, useRef, useState } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import type { RpcStub } from "capnweb";
import {
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import type { ItxHandle } from "~/itx/handle.ts";
import { useItx } from "~/itx/itx-react.tsx";
import { ItxRepl } from "~/components/itx-repl.tsx";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: () => <ConnectedItxRepl context="global" />,
});

/** The shared "connecting to itx" fallback both repls suspend behind. */
export function ItxReplConnecting() {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Connecting to itx...
    </div>
  );
}

/**
 * The one connect wrapper both repls share. `useItx` never SSRs and suspends
 * until connected, so this gates it behind ClientOnly (the route still SSRs its
 * shell) + Suspense, then renders the repl against the live pooled handle.
 * `poolContext` is the useItx key — a project id, or undefined for global = the
 * connect endpoint. It also keys the inner component, so switching project
 * remounts the repl with a fresh scope + history.
 */
export function ConnectedItxRepl({
  poolContext,
  context = "global",
  initialCode,
  scope,
}: {
  poolContext?: string;
  context?: "global" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  return (
    <ClientOnly fallback={<ItxReplConnecting />}>
      <Suspense fallback={<ItxReplConnecting />}>
        <ItxReplConnected
          key={poolContext ?? "global"}
          poolContext={poolContext}
          context={context}
          initialCode={initialCode}
          scope={scope}
        />
      </Suspense>
    </ClientOnly>
  );
}

function ItxReplConnected({
  poolContext,
  context,
  initialCode,
  scope,
}: {
  poolContext?: string;
  context?: "global" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const itx = useItx({ projectId: poolContext });
  return <ItxReplPage itx={itx} context={context} initialCode={initialCode} scope={scope} />;
}

function ItxReplPage({
  // The live itx handle from the pool (useItx). The REPL never owns this stub:
  // it must NOT dispose it or close the socket — the pool owns the connection's
  // lifetime and every other component on this context rides the same socket.
  itx,
  context = "global",
  initialCode = DEFAULT_BROWSER_REPL_CODE,
  scope,
}: {
  itx: RpcStub<ItxHandle>;
  context?: "global" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState("Ready");
  const [entries, setEntries] = useState<BrowserReplEntry[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Scope is fixed for this instance: ConnectedItxRepl keys by context, so a
  // project switch remounts (fresh scope), not a re-sync on render.
  const scopeRef = useRef<Record<string, unknown>>(createBrowserReplScope(scope));

  // Expose the live handle on globalThis for console poking. This only
  // binds/clears a reference — it never disposes `itx` or closes the socket
  // (the pool owns that). A fresh stub after a pool reconnect rebinds here.
  useEffect(() => {
    const globals = globalThis as typeof globalThis & { itx?: RpcStub<ItxHandle> };
    globals.itx = itx;
    return () => {
      if (globals.itx === itx) delete globals.itx;
    };
  }, [itx]);

  async function run() {
    const trimmedCode = code.trim();
    if (trimmedCode === "") return;
    setStatus("Running...");
    setCode("");
    const entry = await runBrowserReplEntry({
      code: trimmedCode,
      itx,
      scope: scopeRef.current,
    });
    setEntries((current) => [...current, entry]);
    setStatus("Ready");
  }

  function selectExample(exampleCode: string) {
    setCode(exampleCode);
    setExamplesOpen(false);
  }

  return (
    <ItxRepl
      canRun={status !== "Running..." && code.trim() !== ""}
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

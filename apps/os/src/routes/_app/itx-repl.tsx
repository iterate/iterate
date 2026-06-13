// The browser itx REPL: a Cap'n Web session straight from the browser tab to
// /api/itx, with `itx` in scope. Because itx is symmetric, anything you can
// do here you can do from Node, a worker cap, or the config worker — and the
// browser can PROVIDE live capabilities too (see the examples).
//
// The REPL rides the ONE browser itx primitive — useItx / the pool
// (~/itx/use-itx.ts). It does NOT open its own socket: the global repl shares
// the tab's global socket, the project repl shares that project's socket, and
// neither owns the connection's lifetime. See the use-itx.ts header for the
// single-socket-per-context model and the disposal contract.

import { Suspense, useEffect, useRef, useState } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import type { RpcStub } from "capnweb";
import {
  browserReplExternalScopesEqual,
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import type { ItxHandle } from "~/itx/handle.ts";
import { useItx } from "~/itx/use-itx.ts";
import { ItxRepl } from "~/components/itx-repl.tsx";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: GlobalItxReplRoute,
});

/** The shared "connecting to itx" fallback every repl suspends behind. */
export function ItxReplConnecting() {
  return <div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>;
}

function GlobalItxReplRoute() {
  // useItx never SSRs and suspends until its socket connects, so the repl needs
  // both gates: ClientOnly (this route still SSRs its shell) and Suspense.
  return (
    <ClientOnly fallback={<ItxReplConnecting />}>
      <Suspense fallback={<ItxReplConnecting />}>
        <GlobalItxReplConnected />
      </Suspense>
    </ClientOnly>
  );
}

function GlobalItxReplConnected() {
  const itx = useItx();
  return <ItxReplPage itx={itx} context="global" />;
}

export function ItxReplPage({
  // The live itx handle from the pool (useItx). The REPL never owns this stub:
  // it must NOT dispose it or close the socket — the pool owns the connection's
  // lifetime and every other component on this context rides the same socket.
  // On a pool reconnect, useItx re-suspends and hands a fresh stub; this
  // component remounts with it (the globalThis binding effect below rebinds).
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
  const envRef = useRef<Record<string, unknown>>({});
  const externalScopeRef = useRef(scope);
  const scopeRef = useRef<Record<string, unknown>>(createBrowserReplScope(scope));

  // Keep injected values in sync when navigating between project repls, without
  // wiping REPL-created bindings on ordinary state updates.
  if (!browserReplExternalScopesEqual(externalScopeRef.current, scope)) {
    externalScopeRef.current = scope;
    scopeRef.current = createBrowserReplScope(scope);
  }

  // Expose the live handle on globalThis for console poking. This only
  // binds/clears a reference — it never disposes `itx` or closes the socket
  // (the pool owns that). A fresh stub after a pool reconnect rebinds here.
  useEffect(() => {
    const globals = globalThis as typeof globalThis & {
      itx?: RpcStub<ItxHandle>;
      env?: object;
    };
    globals.itx = itx;
    globals.env = envRef.current;
    return () => {
      if (globals.itx === itx) delete globals.itx;
      delete globals.env;
    };
  }, [itx]);

  async function run() {
    const trimmedCode = code.trim();
    if (trimmedCode === "") return;
    setStatus("Running...");
    setCode("");
    const entry = await runBrowserReplEntry({
      code: trimmedCode,
      env: envRef.current,
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

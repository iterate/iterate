// The browser itx REPL: a Cap'n Web session straight from the browser tab to
// itx (/api), with `itx` in scope — the OS Session (not an itx)
// in the top-level session REPL, the project itx in a project REPL. Because itx is
// symmetric, anything you can do here you can do from Node, runScript, or a
// dynamic worker — and the browser can PROVIDE live capabilities too (see the
// examples).
//
// The REPL rides the ONE browser itx session — useSession (~/itx/itx-react.tsx).
// It does NOT open its own socket: the tab has a single itx socket, and the
// global repl uses the Session while a project repl narrows it via
// session.projects.get(id); neither owns the connection. ConnectedItxRepl is
// the single connect wrapper both routes use. See the itx-react.tsx header for
// the one-socket model and the disposal contract.

import { Suspense, useEffect, useRef, useState } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import {
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import { useSession, type ItxReactHandle } from "~/itx/itx-react.tsx";
import { ItxRepl } from "~/components/itx-repl.tsx";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: () => <ConnectedItxRepl context="session" />,
});

/** The shared "connecting to itx" fallback both repls suspend behind. */
function ItxReplConnecting() {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Connecting to itx...
    </div>
  );
}

/**
 * The one connect wrapper both repls share. `useSession` never SSRs and suspends
 * until connected, so this gates it behind ClientOnly (the route still SSRs its
 * shell) + Suspense, then renders the repl against the live handle. `poolContext`
 * is a project id/slug to narrow to, or undefined for the global session. It also
 * keys the inner component, so switching project remounts the repl with a fresh
 * scope + history.
 */
export function ConnectedItxRepl({
  poolContext,
  context = "session",
  initialCode,
  scope,
}: {
  poolContext?: string;
  context?: "session" | "project";
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
  context?: "session" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  // One socket either way: the session (global REPL) or a project itx narrowed
  // from it (`session.projects.get`, poolContext = a project id/slug). The pool
  // owns the connection; the REPL never disposes this handle.
  const session = useSession();
  const itx = (poolContext === undefined
    ? session
    : session.projects.get(poolContext)) as unknown as ItxReactHandle;
  return <ItxReplPage itx={itx} context={context} initialCode={initialCode} scope={scope} />;
}

function ItxReplPage({
  // The live itx handle from the pool (useItx). The REPL never owns this stub:
  // it must NOT dispose it or close the socket — the pool owns the connection's
  // lifetime and every other component on this context rides the same socket.
  itx,
  context = "session",
  initialCode = DEFAULT_BROWSER_REPL_CODE,
  scope,
}: {
  itx: ItxReactHandle;
  context?: "session" | "project";
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState("Ready");
  const [entries, setEntries] = useState<BrowserReplEntry[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Scope is fixed for this instance: ConnectedItxRepl keys by context, so a
  // project switch remounts (fresh scope), not a re-sync on render. Lazily
  // initialized so the scope isn't rebuilt (and discarded) on every render.
  const scopeRef = useRef<Record<string, unknown> | null>(null);
  const replScope = (scopeRef.current ??= createBrowserReplScope(scope));

  // Expose the live handle on globalThis for console poking. This only
  // binds/clears a reference — it never disposes `itx` or closes the socket
  // (the pool owns that). A fresh stub after a pool reconnect rebinds here.
  useEffect(() => {
    const globals = globalThis as typeof globalThis & { itx?: ItxReactHandle };
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
      scope: replScope,
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

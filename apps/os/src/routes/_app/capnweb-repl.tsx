import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import {
  BROWSER_REPL_EXAMPLES,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/capnweb/browser-repl.ts";
import type { IterateContext } from "~/capnweb/iterate-context-capability.ts";
import { CapnwebRepl } from "~/components/capnweb-repl.tsx";

export const Route = createFileRoute("/_app/capnweb-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: CapnwebReplPage,
});

export type BrowserReplSession = {
  close(): void;
  ctx: RpcStub<IterateContext>;
};

export type BrowserReplSessionFactory = () => BrowserReplSession | Promise<BrowserReplSession>;

export function createRootBrowserReplSession(): BrowserReplSession {
  const wsUrl = new URL("/api/captnweb", window.location.href);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl);
  const rpc = newWebSocketRpcSession<IterateContext>(socket);

  return {
    ctx: rpc,
    close() {
      rpc[Symbol.dispose]?.();
      socket.close();
    },
  };
}

export function CapnwebReplPage({
  connectSession = createRootBrowserReplSession,
  initialCode = DEFAULT_BROWSER_REPL_CODE,
  scope,
}: {
  connectSession?: BrowserReplSessionFactory;
  initialCode?: string;
  scope?: Record<string, unknown>;
}) {
  const [code, setCode] = useState(initialCode);
  const [ctx, setCtx] = useState<RpcStub<IterateContext> | null>(null);
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
      ctx?: RpcStub<IterateContext>;
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
        globals.ctx = connectedSession.ctx;
        globals.env = envRef.current;
        setCtx(() => connectedSession.ctx);
        setStatus("Connected");
      })
      .catch((error: unknown) => {
        if (closed) return;
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => {
      closed = true;
      delete globals.ctx;
      delete globals.env;
      session?.close();
    };
  }, [connectSession]);

  async function run() {
    const trimmedCode = code.trim();
    if (!ctx || trimmedCode === "") return;
    setStatus("Running...");
    const entry = await runBrowserReplEntry({
      code: trimmedCode,
      ctx,
      env: envRef.current,
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
    <CapnwebRepl
      canRun={Boolean(ctx) && status !== "Running..." && code.trim() !== ""}
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

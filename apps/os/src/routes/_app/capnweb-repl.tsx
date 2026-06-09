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

function CapnwebReplPage() {
  const [code, setCode] = useState(DEFAULT_BROWSER_REPL_CODE);
  const [ctx, setCtx] = useState<RpcStub<IterateContext> | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [entries, setEntries] = useState<BrowserReplEntry[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [selectAllSignal, setSelectAllSignal] = useState(0);
  const envRef = useRef<Record<string, unknown>>({});
  const scopeRef = useRef<Record<string, unknown>>({ RpcTarget });

  useEffect(() => {
    const wsUrl = new URL("/api/captnweb", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl);
    const rpc = newWebSocketRpcSession<IterateContext>(socket);
    const globals = globalThis as typeof globalThis & {
      ctx?: RpcStub<IterateContext>;
      env?: object;
    };
    globals.ctx = rpc;
    globals.env = envRef.current;
    setCtx(() => rpc);
    setStatus("Connected");
    return () => {
      delete globals.ctx;
      delete globals.env;
      rpc[Symbol.dispose]?.();
      socket.close();
    };
  }, []);

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

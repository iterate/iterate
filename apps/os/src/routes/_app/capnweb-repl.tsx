import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { Play } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplSessionCode,
  formatBrowserReplResult,
} from "~/capnweb/browser-repl.ts";
import { liftLocalProxies } from "~/capnweb/local-proxy-wrapper.js";
import type { IterateContext } from "~/capnweb/iterate-context-capability.ts";

export const Route = createFileRoute("/_app/capnweb-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: CapnwebReplPage,
});

type ReplEntry = {
  code: string;
  output: string;
  status: "error" | "success";
};

function CapnwebReplPage() {
  const [code, setCode] = useState(DEFAULT_BROWSER_REPL_CODE);
  const [ctx, setCtx] = useState<RpcStub<IterateContext> | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [entries, setEntries] = useState<ReplEntry[]>([]);
  const envRef = useRef<Record<string, unknown>>({});
  const scopeRef = useRef<Record<string, unknown>>({});

  useEffect(() => {
    const wsUrl = new URL("/api/captnweb", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl);
    const rpc = newWebSocketRpcSession<IterateContext>(socket);
    const lifted = liftLocalProxies(rpc) as RpcStub<IterateContext>;
    const globals = globalThis as typeof globalThis & {
      ctx?: RpcStub<IterateContext>;
      env?: object;
    };
    globals.ctx = lifted;
    globals.env = envRef.current;
    setCtx(lifted);
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
    try {
      const result = await evalBrowserReplSessionCode({
        code: trimmedCode,
        ctx,
        env: envRef.current,
        scope: scopeRef.current,
      });
      setEntries((current) => [
        ...current,
        { code: trimmedCode, output: formatBrowserReplResult(result), status: "success" },
      ]);
      setCode("");
      setStatus("Connected");
    } catch (error) {
      setEntries((current) => [
        ...current,
        {
          code: trimmedCode,
          output: error instanceof Error ? (error.stack ?? error.message) : String(error),
          status: "error",
        },
      ]);
      setStatus("Connected");
    }
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <section className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5">
            {entries.length === 0 ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground">
                iterate&gt;
              </div>
            ) : (
              entries.map((entry, index) => (
                <div key={index} className="flex flex-col gap-2 font-mono text-sm">
                  <pre className="overflow-x-auto whitespace-pre-wrap text-foreground">
                    <span className="select-none text-muted-foreground">iterate&gt; </span>
                    {entry.code}
                  </pre>
                  <pre
                    className={
                      entry.status === "error"
                        ? "overflow-x-auto whitespace-pre-wrap text-destructive"
                        : "overflow-x-auto whitespace-pre-wrap text-muted-foreground"
                    }
                  >
                    {entry.output}
                  </pre>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <div className="border-t bg-background">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-muted-foreground">iterate&gt;</span>
              <span className="text-xs text-muted-foreground">{status}</span>
            </div>
            <SourceCodeBlock
              code={code}
              className="min-h-24"
              editable
              language="typescript"
              onChange={setCode}
              onModEnter={() => void run()}
              showCopyButton={false}
            />
            <Button
              className="self-end"
              disabled={!ctx || status === "Running..." || code.trim() === ""}
              onClick={() => void run()}
              size="sm"
            >
              <Play data-icon="inline-start" />
              Run
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

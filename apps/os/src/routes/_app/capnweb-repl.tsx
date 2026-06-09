import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { BookOpen, ChevronDown, CircleHelp, Play } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  BROWSER_REPL_EXAMPLES,
  DEFAULT_BROWSER_REPL_CODE,
  runBrowserReplEntry,
  type BrowserReplEntry,
} from "~/capnweb/browser-repl.ts";
import { liftLocalProxies } from "~/capnweb/local-proxy-wrapper.js";
import type { IterateContext } from "~/capnweb/iterate-context-capability.ts";

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
  const envRef = useRef<Record<string, unknown>>({});
  const scopeRef = useRef<Record<string, unknown>>({ RpcTarget });

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
    setCtx(() => lifted);
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
    if (entry.status === "success") setCode("");
    setStatus("Connected");
  }

  function selectExample(exampleCode: string) {
    setCode(exampleCode);
    setExamplesOpen(false);
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
                <div key={index} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                    <span className="select-none">iterate&gt;</span>
                  </div>
                  <SourceCodeBlock
                    code={entry.code}
                    className="max-h-80"
                    language="typescript"
                    showCopyButton
                  />
                  {entry.consoleOutput ? (
                    <ReplCollapsibleCodeBlock
                      code={entry.consoleOutput}
                      language="text"
                      title="Console"
                    />
                  ) : null}
                  <ReplCollapsibleCodeBlock
                    code={entry.output}
                    language={entry.outputLanguage}
                    title={entry.status === "error" ? "Error" : "Result"}
                    variant={entry.status === "error" ? "error" : "default"}
                  />
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <div className="border-t bg-background">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">iterate&gt;</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                        aria-label="REPL result aliases"
                      />
                    }
                  >
                    <CircleHelp className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Use <code>$_</code> or <code>_</code> for the last successful result.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="text-xs text-muted-foreground">{status}</span>
            </div>
            <SourceCodeBlock
              code={code}
              className="min-h-24"
              editable
              language="typescript"
              onChange={setCode}
              onModEnter={() => void run()}
              showCopyButton
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setExamplesOpen(true)} size="sm">
                <BookOpen data-icon="inline-start" />
                Examples
              </Button>
              <Button
                disabled={!ctx || status === "Running..." || code.trim() === ""}
                onClick={() => void run()}
                size="sm"
              >
                <Play data-icon="inline-start" />
                Run
              </Button>
            </div>
          </div>
        </div>
      </section>
      <Sheet open={examplesOpen} onOpenChange={setExamplesOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,48rem)] data-[side=right]:sm:max-w-[min(92vw,48rem)]">
          <SheetHeader className="border-b px-4 py-3 pr-14">
            <SheetTitle>Examples</SheetTitle>
            <SheetDescription>Runnable snippets for the current REPL session.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {BROWSER_REPL_EXAMPLES.map((example) => (
                <article key={example.id} className="flex flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium">{example.title}</h3>
                    <p className="text-sm text-muted-foreground">{example.description}</p>
                  </div>
                  <SourceCodeBlock
                    code={example.code}
                    className="h-80"
                    language="typescript"
                    showCopyButton
                  />
                  <Button
                    className="self-end"
                    onClick={() => selectExample(example.code)}
                    size="sm"
                    variant="outline"
                  >
                    Use snippet
                  </Button>
                </article>
              ))}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </main>
  );
}

function ReplCollapsibleCodeBlock(input: {
  code: string;
  language: "json" | "text" | "typescript";
  title: string;
  variant?: "default" | "error";
}) {
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger
          className={
            input.variant === "error"
              ? "group flex items-center gap-1 text-xs font-medium text-destructive"
              : "group flex items-center gap-1 text-xs font-medium text-muted-foreground"
          }
        >
          <ChevronDown className="size-3 -rotate-90 transition-transform [[data-panel-open]_&]:rotate-0" />
          {input.title}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <SourceCodeBlock
          code={input.code}
          className={
            input.variant === "error"
              ? "mt-1 max-h-96 [&_.cm-content]:text-destructive"
              : "mt-1 max-h-96"
          }
          language={input.language}
          showCopyButton
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

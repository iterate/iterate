import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import { BookOpen, ChevronDown, Play } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import {
  SourceCodeBlock,
  type SourceCodeBlockExtension,
} from "@iterate-com/ui/components/source-code-block";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import type { BrowserReplEntry } from "~/itx/browser-repl.ts";
import type { ItxExample } from "~/itx/examples.ts";

const REPL_SOURCE_PATH = "/repl.ts";
const replCodeBlockClassName =
  "min-h-0 [&_.cm-content]:font-mono [&_.cm-line]:px-0 [&_.cm-scroller]:font-mono";

export interface ItxReplProps {
  canRun: boolean;
  code: string;
  entries: BrowserReplEntry[];
  examples: ItxExample[];
  examplesOpen: boolean;
  onChangeCode: (code: string) => void;
  onRun: () => void;
  onSelectExample: (code: string) => void;
  onSetExamplesOpen: (open: boolean) => void;
  status: string;
}

export function ItxRepl({
  canRun,
  code,
  entries,
  examples,
  examplesOpen,
  onChangeCode,
  onRun,
  onSelectExample,
  onSetExamplesOpen,
  status,
}: ItxReplProps) {
  const typeScriptExtensions = useReplTypeScriptExtensions({
    code,
    path: REPL_SOURCE_PATH,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <section className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5">
            <div className="flex items-start justify-between gap-3 border-b pb-3">
              <div className="min-w-0 space-y-1 text-sm text-muted-foreground">
                <p>
                  <span className="text-foreground">
                    Run TypeScript against your Iterate context.
                  </span>{" "}
                  Start with <code className="font-mono text-xs">itx</code>, await async calls, and
                  use <code className="font-mono text-xs">$_</code> or{" "}
                  <code className="font-mono text-xs">_</code> for the last successful result.
                </p>
                <p>
                  Try{" "}
                  <code className="font-mono text-xs">
                    await itx.projects.list({"{"} limit: 5 {"}"})
                  </code>
                  , then edit the selected input and run again.
                </p>
              </div>
              <Button
                className="shrink-0"
                variant="ghost"
                onClick={() => onSetExamplesOpen(true)}
                size="sm"
              >
                <BookOpen data-icon="inline-start" />
                Examples
              </Button>
            </div>
            {entries.map((entry, index) => (
              <div
                key={index}
                className={
                  entry.status === "error"
                    ? "flex flex-col gap-2 border-l-2 border-destructive/50 bg-destructive/5 py-2 pr-3 pl-3"
                    : "flex flex-col gap-2 border-l-2 border-muted-foreground/25 bg-muted/25 py-2 pr-3 pl-3"
                }
              >
                <ReplPromptRow status={null} />
                <ReplCodeBlock code={entry.code} language="typescript" />
                {entry.consoleOutput ? (
                  <ReplCollapsibleCodeBlock
                    code={entry.consoleOutput}
                    language="text"
                    title="Console"
                  />
                ) : null}
                {entry.status === "success" ? (
                  <ReplCollapsibleSerializedBlock data={entry.result} title="Result" />
                ) : (
                  <ReplCollapsibleCodeBlock
                    code={entry.output}
                    language={entry.outputLanguage}
                    title="Error"
                    variant="error"
                  />
                )}
              </div>
            ))}
            <div className="flex flex-col gap-2 border-l-2 border-primary/50 py-2 pr-3 pl-3">
              <ReplPromptRow status={status}>
                <Button disabled={!canRun} onClick={onRun} size="sm">
                  <Play data-icon="inline-start" />
                  Run
                </Button>
              </ReplPromptRow>
              <SourceCodeBlock
                code={code}
                className={`${replCodeBlockClassName} min-h-24`}
                codeMirrorExtensions={typeScriptExtensions}
                editable
                language="typescript"
                onChange={onChangeCode}
                onModEnter={onRun}
                plainChrome
                showCopyButton={false}
                showLineNumbers={false}
              />
              <div ref={bottomRef} />
            </div>
          </div>
        </ScrollArea>
      </section>
      <Sheet open={examplesOpen} onOpenChange={onSetExamplesOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,48rem)] data-[side=right]:sm:max-w-[min(92vw,48rem)]">
          <SheetHeader className="border-b px-4 py-3 pr-14">
            <SheetTitle>Examples</SheetTitle>
            <SheetDescription>Runnable snippets for the current REPL session.</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {examples.map((example) => (
                <article key={example.id} className="flex flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium">{example.title}</h3>
                    <p className="text-sm text-muted-foreground">{example.description}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {example.context === "project" ? "project context" : "global context"}
                      {" · runs in: "}
                      {example.runtimes.join(", ")}
                    </p>
                  </div>
                  <SourceCodeBlock
                    code={example.code}
                    className="h-80"
                    language="typescript"
                    showCopyButton
                  />
                  <Button
                    className="self-end"
                    onClick={() => onSelectExample(example.code)}
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

function useReplTypeScriptExtensions(input: { code: string; path: string }) {
  const codeRef = useRef(input.code);
  codeRef.current = input.code;
  const [extensions, setExtensions] = useState<readonly SourceCodeBlockExtension[]>([]);

  useEffect(() => {
    let innerWorker: Worker | null = null;
    let releaseWorker: (() => void) | null = null;
    let disposed = false;

    async function initializeTypeScriptExtensions() {
      const [autocompleteModule, comlinkModule, typeScriptExtensionsModule] = await Promise.all([
        import("@codemirror/autocomplete"),
        import("comlink"),
        import("@valtown/codemirror-ts"),
      ]);

      if (disposed) return;

      innerWorker = new Worker(new URL("./itx-repl-typescript.worker.ts", import.meta.url), {
        type: "module",
      });
      const remoteWorker = comlinkModule.wrap<WorkerShape>(innerWorker);
      releaseWorker = () => remoteWorker[comlinkModule.releaseProxy]?.();

      await remoteWorker.initialize();
      await remoteWorker.updateFile({
        path: input.path,
        code: codeRef.current,
      });

      if (disposed) {
        releaseWorker();
        innerWorker.terminate();
        return;
      }

      const { tsAutocompleteWorker, tsFacetWorker, tsHoverWorker, tsLinterWorker, tsSyncWorker } =
        typeScriptExtensionsModule;

      setExtensions([
        tsFacetWorker.of({ path: input.path, worker: remoteWorker }),
        tsSyncWorker(),
        tsLinterWorker(),
        autocompleteModule.autocompletion({
          activateOnTyping: true,
          activateOnTypingDelay: 0,
          override: [tsAutocompleteWorker()],
        }),
        tsHoverWorker(),
      ]);
    }

    void initializeTypeScriptExtensions().catch((error: unknown) => {
      if (disposed) return;
      console.error("[itx-repl] Failed to initialize TypeScript worker", error);
    });

    return () => {
      disposed = true;
      releaseWorker?.();
      innerWorker?.terminate();
    };
  }, [input.path]);

  return useMemo(() => extensions, [extensions]);
}

function ReplPromptRow(input: { children?: ReactNode; status: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-xs text-muted-foreground">iterate&gt;</span>
      <div className="flex items-center gap-2">
        {input.status ? (
          <span className="text-xs text-muted-foreground">{input.status}</span>
        ) : null}
        {input.children}
      </div>
    </div>
  );
}

function ReplCodeBlock(input: { code: string; language: "json" | "text" | "typescript" }) {
  return (
    <SourceCodeBlock
      code={input.code}
      className={
        input.language === "text" ? replCodeBlockClassName : `${replCodeBlockClassName} max-h-80`
      }
      language={input.language}
      plainChrome
      showCopyButton
      showLineNumbers={false}
    />
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
        <div className={input.variant === "error" ? "[&_.cm-content]:text-destructive" : ""}>
          <ReplCodeBlock code={input.code} language={input.language} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReplCollapsibleSerializedBlock(input: { data: unknown; title: string }) {
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ChevronDown className="size-3 -rotate-90 transition-transform [[data-panel-open]_&]:rotate-0" />
          {input.title}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <SerializedObjectCodeBlock
          className="max-h-96"
          data={input.data}
          initialFormat="json"
          showCopyButton
          showLineNumbers
          showToggle
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

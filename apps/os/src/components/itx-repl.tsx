// The durable REPL's presentational layer. Entries are STREAM-DERIVED
// (the container folds the scope stream's script-run-requested/settled events
// — see itx-scope-repl.tsx); this component renders the list, the CodeMirror
// editor with its TypeScript worker, and the examples sheet. Runs execute
// server-side in the user's personal capability scope, so there is no console
// affordance (return values are the output; journaled console output is a
// noted follow-up in tasks/durable-repl.md).

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import { itxReplAutocompleteWorker } from "./itx-repl-autocomplete.ts";
import type { ItxReplTypeScriptWorker } from "./itx-repl-types.ts";
import type { ReplRunEntry } from "./itx-scope-repl-entries.ts";
import type { ItxExample } from "~/itx/examples.ts";

const REPL_SOURCE_PATH = "/repl.ts";
const replCodeBlockClassName =
  "min-h-0 [&_.cm-content]:font-mono [&_.cm-line]:px-0 [&_.cm-scroller]:font-mono";
const loadTypeScriptExtensionModules = import.meta.env.SSR
  ? null
  : async () =>
      Promise.all([
        import("@codemirror/autocomplete"),
        import("comlink"),
        import("@valtown/codemirror-ts"),
      ]);

interface ItxReplProps {
  canRun: boolean;
  code: string;
  entries: ReplRunEntry[];
  examples: ItxExample[];
  examplesOpen: boolean;
  onChangeCode: (code: string) => void;
  onRun: () => void;
  onSelectExample: (code: string) => void;
  onSetExamplesOpen: (open: boolean) => void;
  /** The submitted-but-not-yet-journaled Run (null once its request event lands). */
  pendingCode: string | null;
  /** A Run failure with no journaled settlement (transport, scope birth). */
  runError: string | null;
  /** The per-user capability scope Runs execute in, e.g. /repl/usr123. */
  scopePath: string;
  /** The scope's assembled preamble (typed `results`) for the editor worker. */
  scopePreamble: string | null;
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
  pendingCode,
  runError,
  scopePath,
  scopePreamble,
  status,
}: ItxReplProps) {
  const typeScriptExtensions = useReplTypeScriptExtensions({
    code,
    path: REPL_SOURCE_PATH,
    scopePreamble,
  });
  const runButtonLabel = typeScriptExtensions.loading ? "Loading..." : "Run";
  const bottomRef = useRef<HTMLDivElement>(null);
  const entryCount = entries.length + (pendingCode === null ? 0 : 1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entryCount]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <section className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5">
            <div className="flex items-start justify-between gap-3 border-b pb-3">
              <div className="min-w-0 space-y-1 text-sm text-muted-foreground">
                <p>
                  <span className="text-foreground">Run TypeScript as real project scripts.</span>{" "}
                  Scripts execute server-side in your scope (
                  <code className="font-mono text-xs">{scopePath}</code>), typechecked and journaled
                  — reload and the session is still here. Use{" "}
                  <code className="font-mono text-xs">return</code> to produce a result; prior
                  results stay in scope as{" "}
                  <code className="font-mono text-xs">results[0].data</code> (or{" "}
                  <code className="font-mono text-xs">await results[0].load(itx)</code> for large
                  ones).
                </p>
                <p>
                  Try <code className="font-mono text-xs">return await itx.__describe()</code>, then
                  edit and run again.
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
              <ReplEntryRow key={entry.executionId} entry={entry} index={index} />
            ))}
            {pendingCode === null ? null : (
              <ReplEntryRow
                entry={{
                  code: pendingCode,
                  executionId: "pending",
                  requestedAt: "",
                  requestedAtOffset: -1,
                  status: "running",
                }}
                index={entries.length}
              />
            )}
            <div className="flex flex-col gap-2 border-l-2 border-primary/50 py-2 pr-3 pl-3">
              <ReplPromptRow status={typeScriptExtensions.loading ? null : status}>
                <Button
                  data-spinner={typeScriptExtensions.loading ? "true" : undefined}
                  disabled={typeScriptExtensions.loading || !canRun}
                  onClick={onRun}
                  size="sm"
                >
                  <Play data-icon="inline-start" />
                  {runButtonLabel}
                </Button>
              </ReplPromptRow>
              <div data-testid="itx-repl-editor">
                <SourceCodeBlock
                  code={code}
                  className={`${replCodeBlockClassName} min-h-24`}
                  codeMirrorExtensions={typeScriptExtensions.extensions}
                  editable
                  language="typescript"
                  onChange={onChangeCode}
                  onModEnter={onRun}
                  plainChrome
                  showCopyButton={false}
                  showLineNumbers={false}
                />
              </div>
              {runError === null ? null : (
                <p
                  className="font-mono text-xs whitespace-pre-wrap text-destructive"
                  data-testid="itx-repl-run-error"
                >
                  {runError}
                </p>
              )}
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
              {examples.map((example) => {
                // Runs execute server-side as scope scripts in a project
                // context, so a snippet is runnable here exactly when it
                // declares the browser runtime AND a project context. The rest
                // (session catalog, live providers, agent-only members) is
                // reading material for the node SDK / CLI / agents.
                const runnableHere =
                  example.context === "project" && example.runtimes.includes("browser");
                return (
                  <article key={example.id} className="flex flex-col gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-medium">{example.title}</h3>
                      <p className="text-sm text-muted-foreground">{example.description}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {example.context} context
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
                    <div className="flex items-center justify-end gap-3">
                      {!runnableHere ? (
                        <span className="text-xs text-muted-foreground">
                          Not runnable here — needs {example.runtimes.join("/")}
                          {example.context === "project" ? "" : ` (${example.context} context)`}.
                        </span>
                      ) : null}
                      <Button
                        disabled={!runnableHere}
                        onClick={() => onSelectExample(example.code)}
                        size="sm"
                        variant="outline"
                      >
                        Use snippet
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </main>
  );
}

/** One journaled Run: the code, then its outcome (or a live spinner). The
 * testids/data attributes are the Playwright specs' contract — keep stable. */
function ReplEntryRow({ entry, index }: { entry: ReplRunEntry; index: number }) {
  return (
    <div
      data-testid="itx-repl-entry"
      data-status={entry.status}
      data-entry-index={index}
      className={
        entry.status === "error"
          ? "flex flex-col gap-2 border-l-2 border-destructive/50 bg-destructive/5 py-2 pr-3 pl-3"
          : "flex flex-col gap-2 border-l-2 border-muted-foreground/25 bg-muted/25 py-2 pr-3 pl-3"
      }
    >
      <ReplPromptRow status={entry.status === "running" ? "Running..." : null} />
      <ReplCodeBlock code={entry.code} language="typescript" />
      {entry.status === "success" ? (
        <>
          <div data-testid="itx-repl-visible-result">
            <ReplCollapsibleSerializedBlock data={entry.result} title="Result" />
          </div>
          <pre data-testid="itx-repl-result-json" hidden>
            {JSON.stringify(entry.result, null, 2)}
          </pre>
        </>
      ) : entry.status === "error" ? (
        <>
          <div data-testid="itx-repl-visible-error">
            <ReplCollapsibleCodeBlock
              code={entry.error}
              language="text"
              title="Error"
              variant="error"
            />
          </div>
          <pre data-testid="itx-repl-error" data-type="error" hidden>
            {entry.error}
          </pre>
        </>
      ) : null}
    </div>
  );
}

function useReplTypeScriptExtensions(input: {
  code: string;
  path: string;
  scopePreamble: string | null;
}) {
  const codeRef = useRef(input.code);
  codeRef.current = input.code;
  const [extensions, setExtensions] = useState<readonly SourceCodeBlockExtension[]>([]);
  const [loading, setLoading] = useState(Boolean(loadTypeScriptExtensionModules));
  const remoteWorkerRef = useRef<ItxReplTypeScriptWorker | null>(null);

  useEffect(() => {
    let innerWorker: Worker | null = null;
    let releaseWorker: (() => void) | null = null;
    let disposed = false;

    async function initializeTypeScriptExtensions() {
      if (!loadTypeScriptExtensionModules) {
        setLoading(false);
        return;
      }
      const [autocompleteModule, comlinkModule, typeScriptExtensionsModule] =
        await loadTypeScriptExtensionModules();

      if (disposed) return;

      innerWorker = new Worker(new URL("./itx-repl-typescript.worker.ts", import.meta.url), {
        type: "module",
      });
      const remoteWorker = comlinkModule.wrap<ItxReplTypeScriptWorker>(innerWorker);
      releaseWorker = () => {
        remoteWorkerRef.current = null;
        remoteWorker[comlinkModule.releaseProxy]?.();
      };

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
      remoteWorkerRef.current = remoteWorker;

      const { tsFacetWorker, tsHoverWorker, tsLinterWorker, tsSyncWorker } =
        typeScriptExtensionsModule;

      setExtensions([
        tsFacetWorker.of({ path: input.path, worker: remoteWorker }),
        tsSyncWorker(),
        tsLinterWorker(),
        autocompleteModule.autocompletion({
          activateOnTyping: true,
          activateOnTypingDelay: 0,
          override: [itxReplAutocompleteWorker(tsFacetWorker)],
        }),
        tsHoverWorker(),
      ]);
      setLoading(false);
    }

    void initializeTypeScriptExtensions().catch((error: unknown) => {
      if (disposed) return;
      console.error("[itx-repl] Failed to initialize TypeScript worker", error);
      setLoading(false);
    });

    return () => {
      disposed = true;
      releaseWorker?.();
      innerWorker?.terminate();
    };
  }, [input.path]);

  // Best-effort scope typing: push the scope's assembled preamble into the
  // worker whenever it changes (a settled Run refreshes it) or once the worker
  // finishes initializing (`extensions` flips). Failures fall back silently to
  // the itx-only types.
  useEffect(() => {
    const remoteWorker = remoteWorkerRef.current;
    if (!remoteWorker) return;
    remoteWorker.setScopeContext({ preambleTs: input.scopePreamble }).catch(() => {});
  }, [input.scopePreamble, extensions]);

  return useMemo(() => ({ extensions, loading }), [extensions, loading]);
}

function ReplPromptRow(input: { children?: ReactNode; status: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-xs text-muted-foreground">iterate&gt;</span>
      <div className="flex items-center gap-2">
        {input.status ? (
          <span
            className="text-xs text-muted-foreground"
            data-spinner={input.status === "Running..." ? "true" : undefined}
          >
            {input.status}
          </span>
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
  const { data, title } = input;
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ChevronDown className="size-3 -rotate-90 transition-transform [[data-panel-open]_&]:rotate-0" />
          {title}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <SerializedObjectCodeBlock
          className="max-h-96"
          data={data}
          initialFormat="json"
          showCopyButton
          showLineNumbers
          showToggle
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

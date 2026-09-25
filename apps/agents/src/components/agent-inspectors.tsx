// The traces, inspector sheets built over the page's own event array: the LLM request (what the
// model was sent, what it answered, what the loop derived) and the script execution (the code, its
// settlement, what the agent was told). One Sheet, URL-backed by the route's search params, so any
// trace is a shareable link. The Events view is the raw log: one row per event, click to inspect.
import { useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "sonner";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "cn";
import type { Event } from "@iterate-com/ui/components/events/types";
import {
  formatAgentUiDuration,
  type AgentUiActivity,
  type AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { sliceText, type StreamText } from "@iterate-com/shared/chunked-text";
import { parseCodemodeResponse } from "../../runtime/codemode-format.ts";
import {
  formatDateTime,
  isRecord,
  llmTrace,
  scriptTrace,
  type LlmTrace,
} from "../lib/agent-events.ts";
import { MessageResponse } from "./message.tsx";
import { StreamingCursor, StreamingText } from "./streaming-text.tsx";

/** Which trace the sheet shows — at most one; the route's search params carry it. */
export type Inspected =
  | { kind: "llmRequest"; llmRequestOffset: number }
  | { kind: "scriptExecution"; executionId: string }
  | null;

export function InspectorSheet({
  events,
  live,
  inspected,
  onInspect,
}: {
  events: readonly Event[];
  /** The reduced live activity, so an in-flight request's trace streams its raw response. */
  live: AgentUiActivity | null;
  inspected: Inspected;
  onInspect: (next: Inspected) => void;
}) {
  // The running llm step for the inspected request (if it is the one in flight): its responseText
  // and thinkingText are the chunk windows folded, i.e. the raw model output as it streams.
  const liveStep =
    inspected?.kind === "llmRequest"
      ? live?.steps.find(
          (step): step is AgentUiLlmStep =>
            step.kind === "llm" &&
            step.status === "running" &&
            step.llmRequestOffset === inspected.llmRequestOffset,
        )
      : undefined;
  return (
    <Sheet open={!!inspected} onOpenChange={(open) => !open && onInspect(null)}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[min(92vw,64rem)] data-[side=right]:sm:max-w-[92vw]"
      >
        {inspected?.kind === "llmRequest" ? (
          <LlmTraceContent
            events={events}
            llmRequestOffset={inspected.llmRequestOffset}
            liveStep={liveStep}
            onInspect={onInspect}
          />
        ) : inspected?.kind === "scriptExecution" ? (
          <ScriptTraceContent events={events} executionId={inspected.executionId} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ── the LLM request ──

function LlmTraceContent({
  events,
  llmRequestOffset,
  liveStep,
  onInspect,
}: {
  events: readonly Event[];
  llmRequestOffset: number;
  liveStep: AgentUiLlmStep | undefined;
  onInspect: (next: Inspected) => void;
}) {
  const trace = llmTrace(events, llmRequestOffset);
  const [renderMode, setRenderMode] = useState<"markdown" | "plain">("markdown");
  const [copied, setCopied] = useState(false);
  if (!trace)
    return (
      <>
        <SheetHeader>
          <SheetTitle>LLM trace #{llmRequestOffset}</SheetTitle>
          <SheetDescription>
            No LLM request at offset #{llmRequestOffset} on this path.
          </SheetDescription>
        </SheetHeader>
      </>
    );
  const totalChars = trace.messages.reduce((sum, message) => sum + message.content.length, 0);
  return (
    <>
      <SheetHeader className="shrink-0 pr-12">
        <SheetTitle className="truncate">
          LLM trace #{llmRequestOffset} · {trace.model}
        </SheetTitle>
        <SheetDescription>
          {formatDateTime(trace.requestedAtMs)} · {trace.messages.length.toLocaleString()} messages
          · {totalChars.toLocaleString()} chars
          <Outcome outcome={trace.outcome} />
        </SheetDescription>
      </SheetHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={renderMode === "plain"}
          title="Toggle between rendered markdown and the verbatim wire text"
          onClick={() => setRenderMode(renderMode === "markdown" ? "plain" : "markdown")}
        >
          {renderMode === "markdown" ? "Markdown" : "Plain text"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          title="Copy the request's messages as JSON"
          onClick={async () => {
            try {
              const messages = trace.messages.map(({ role, content }) => ({ role, content }));
              await navigator.clipboard.writeText(JSON.stringify({ messages }, null, 2));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            } catch {
              toast.error("Failed to copy to clipboard");
            }
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          Copy JSON
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          rebuilt from the log: every context item before the request, as the agent sends them
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t">
        {trace.messages.map((message) => (
          <section key={message.offset} className="border-b border-border/60 px-5 py-3">
            <div className="mb-2 flex items-baseline gap-2">
              <RoleChip name={message.role} />
              <span className="font-mono text-[10px] text-muted-foreground/60">
                #{message.offset} · {message.content.length.toLocaleString()} chars
              </span>
            </div>
            <Body text={message.content} renderMode={renderMode} />
          </section>
        ))}
        <ResponseView
          liveStep={liveStep}
          outcome={trace.outcome}
          onInspect={onInspect}
          scriptExecutionId={trace.derived.scriptExecutionId}
        />
        {trace.derived.prose || trace.derived.scriptExecutionId ? (
          <section className="px-5 py-3">
            <div className="mb-2 flex items-baseline gap-2">
              <RoleChip name="derived" />
              <span className="font-mono text-[10px] text-muted-foreground/60">
                what the loop did with the answer
              </span>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              {trace.derived.prose ? (
                <div>
                  <span className="font-mono text-xs text-muted-foreground">sent to you:</span>
                  <MessageResponse
                    className="min-w-0 max-w-full overflow-hidden text-sm"
                    mode="static"
                    parseIncompleteMarkdown={false}
                  >
                    {trace.derived.prose}
                  </MessageResponse>
                </div>
              ) : null}
              {trace.derived.scriptExecutionId ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    onInspect({
                      kind: "scriptExecution",
                      executionId: trace.derived.scriptExecutionId!,
                    })
                  }
                >
                  Ran a script — open its execution trace
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** The trace's response half: the model's RAW output (streamed live from the chunk windows, or the
 *  settled text after the fact) syntax-highlighted, and the parsed script highlighted as TypeScript
 *  beside it — the two a person debugging a turn reads. Reasoning ("thinking") streams above while it
 *  is in flight; it is ephemeral, so it is gone once the turn settles. */
function ResponseView({
  liveStep,
  outcome,
  onInspect,
  scriptExecutionId,
}: {
  liveStep: AgentUiLlmStep | undefined;
  outcome: LlmTrace["outcome"];
  onInspect: (next: Inspected) => void;
  scriptExecutionId: string | undefined;
}) {
  const streaming = Boolean(liveStep);
  const thinking: StreamText | null =
    liveStep && liveStep.thinkingText.length > 0 ? liveStep.thinkingText : null;
  const raw = liveStep
    ? sliceText(liveStep.responseText)
    : outcome.status === "succeeded"
      ? outcome.text
      : null;
  const hasRaw = Boolean(raw);
  // The loop's own parser, so the pane shows exactly the script the loop runs; a streaming answer
  // shows none until its closing `</codemode>` line arrives.
  const parsed = raw ? parseCodemodeResponse(raw) : null;
  const script = parsed?.kind === "script" ? parsed.code : null;
  return (
    <section className="flex flex-col gap-3 border-b border-border/60 bg-muted/20 px-5 py-3">
      <div className="flex items-baseline gap-2">
        <RoleChip name="response" />
        {streaming ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground/60">
            <Spinner className="size-2.5" /> streaming
          </span>
        ) : hasRaw ? (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {raw!.length.toLocaleString()} chars
          </span>
        ) : null}
      </div>
      {thinking ? (
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            reasoning
          </p>
          <div className="max-w-full whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">
            <StreamingText text={thinking} />
            {hasRaw ? null : <StreamingCursor />}
          </div>
        </div>
      ) : null}
      {hasRaw ? (
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            raw response
          </p>
          <div className="max-h-96 overflow-y-auto rounded-lg">
            <SourceCodeBlock code={raw!} language="markdown" showLineNumbers={false} />
          </div>
        </div>
      ) : null}
      {script ? (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-700">
              parsed script
            </p>
            {scriptExecutionId ? (
              <Button
                variant="ghost"
                size="xs"
                className="font-normal text-muted-foreground"
                onClick={() =>
                  onInspect({ kind: "scriptExecution", executionId: scriptExecutionId })
                }
              >
                Execution trace
                <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
              </Button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-y-auto rounded-lg">
            <SourceCodeBlock code={script} language="typescript" showLineNumbers={false} />
          </div>
        </div>
      ) : null}
      {outcome.status === "failed" ? (
        <pre
          data-type="error"
          className="overflow-x-auto rounded-xl bg-destructive/5 px-4 py-2.5 font-mono text-xs leading-relaxed text-destructive"
        >
          {outcome.errorMessage}
        </pre>
      ) : outcome.status === "cancelled" && !streaming ? (
        <p className="text-sm text-muted-foreground">
          Cancelled{outcome.reason ? ` — ${outcome.reason}` : ""}
          {hasRaw ? " (partial output above)" : ""}
        </p>
      ) : null}
      {streaming && !hasRaw && !thinking ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3" /> Waiting for the first tokens…
        </p>
      ) : null}
    </section>
  );
}

function Outcome({ outcome }: { outcome: LlmTrace["outcome"] }) {
  if (outcome.status === "in flight") return <> · in flight</>;
  const duration =
    "durationMs" in outcome && outcome.durationMs != null
      ? ` in ${formatAgentUiDuration(outcome.durationMs)}`
      : "";
  return (
    <>
      {" · "}
      <span
        className={cn(
          outcome.status === "succeeded" && "text-emerald-600",
          outcome.status === "failed" && "text-destructive",
          outcome.status === "cancelled" && "text-amber-600",
        )}
      >
        {outcome.status}
        {duration}
      </span>
    </>
  );
}

function RoleChip({ name }: { name: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold uppercase tracking-wider",
        name === "system" && "text-purple-700",
        name === "developer" && "text-purple-700/80",
        name === "user" && "text-blue-700",
        name === "assistant" && "text-emerald-700",
        name === "response" && "text-amber-700",
        name === "derived" && "text-muted-foreground",
      )}
    >
      {name}
    </span>
  );
}

function Body({ text, renderMode }: { text: string; renderMode: "markdown" | "plain" }) {
  return renderMode === "markdown" ? (
    <MessageResponse
      className="min-w-0 max-w-full overflow-hidden text-sm"
      mode="static"
      parseIncompleteMarkdown={false}
    >
      {text}
    </MessageResponse>
  ) : (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

// ── the script execution ──

function ScriptTraceContent({
  events,
  executionId,
}: {
  events: readonly Event[];
  executionId: string;
}) {
  const trace = scriptTrace(events, executionId);
  if (!trace)
    return (
      <SheetHeader>
        <SheetTitle>Script execution</SheetTitle>
        <SheetDescription>No script run named {executionId} on this path.</SheetDescription>
      </SheetHeader>
    );
  const settlement = isRecord(trace.settlement?.value) ? trace.settlement.value : null;
  const failed = settlement?.status === "failed";
  return (
    <>
      <SheetHeader className="shrink-0 pr-12">
        <SheetTitle className="truncate">Script execution · {executionId}</SheetTitle>
        <SheetDescription>
          {formatDateTime(trace.requestedAtMs)}
          {trace.settlement ? (
            <>
              {" · "}
              <span className={failed ? "text-destructive" : "text-emerald-600"}>
                {failed ? "failed" : "succeeded"} in{" "}
                {formatAgentUiDuration(trace.settlement.atMs - trace.requestedAtMs)}
              </span>
            </>
          ) : (
            " · running"
          )}
        </SheetDescription>
      </SheetHeader>
      <Tabs defaultValue="code" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-4 h-8 shrink-0">
          <TabsTrigger value="code">Code</TabsTrigger>
          <TabsTrigger value="result">Result</TabsTrigger>
          <TabsTrigger value="agent">What the agent saw</TabsTrigger>
        </TabsList>
        <TabsContent value="code" className="min-h-0 flex-1 overflow-y-auto border-t p-4">
          <SourceCodeBlock code={trace.code} language="typescript" showCopyButton />
        </TabsContent>
        <TabsContent value="result" className="min-h-0 flex-1 overflow-y-auto border-t p-4">
          {settlement ? (
            <SerializedObjectCodeBlock
              data={settlement}
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          ) : (
            <p className="text-sm text-muted-foreground">Not settled yet.</p>
          )}
        </TabsContent>
        <TabsContent value="agent" className="min-h-0 flex-1 overflow-y-auto border-t p-4">
          {trace.rendered ? (
            <MessageResponse
              className="min-w-0 max-w-full overflow-hidden text-sm"
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {trace.rendered}
            </MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing was appended to the agent's context for this run — a script that returns
              nothing ends the turn.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

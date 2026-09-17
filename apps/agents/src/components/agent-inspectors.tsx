// The traces, apps/os's inspector sheets rebuilt over the page's own event array: the LLM request
// (what the model was sent, what it answered, what the loop derived), the script execution (the
// code, its settlement, what the agent was told), and a raw event with Prev/Next paging. One Sheet,
// URL-backed by the route's search params, so any trace is a shareable link. The Events view is
// the raw log: one row per event, click to inspect.
import { useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import type { Event } from "@iterate-com/ui/components/events/types";
import {
  formatClockTime,
  formatDateTime,
  formatSeconds,
  isRecord,
  llmTrace,
  looksLikeCode,
  scriptTrace,
  shortEventType,
  type LlmTrace,
} from "../lib/agent-events.ts";

/** Which trace the sheet shows — at most one; the route's search params carry it. */
export type Inspected =
  | { kind: "llmRequest"; llmRequestOffset: number }
  | { kind: "scriptExecution"; executionId: string }
  | { kind: "event"; offset: number }
  | null;

export function InspectorSheet({
  events,
  inspected,
  onInspect,
}: {
  events: readonly Event[];
  inspected: Inspected;
  onInspect: (next: Inspected) => void;
}) {
  return (
    <Sheet open={!!inspected} onOpenChange={(open) => !open && onInspect(null)}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[min(92vw,64rem)] data-[side=right]:sm:max-w-[92vw]"
      >
        {inspected?.kind === "llmRequest" ? (
          <LlmTraceContent
            events={events}
            llmRequestOffset={inspected.llmRequestOffset}
            onInspect={onInspect}
          />
        ) : inspected?.kind === "scriptExecution" ? (
          <ScriptTraceContent events={events} executionId={inspected.executionId} />
        ) : inspected?.kind === "event" ? (
          <RawEventContent events={events} offset={inspected.offset} onInspect={onInspect} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ── the LLM request ──

function LlmTraceContent({
  events,
  llmRequestOffset,
  onInspect,
}: {
  events: readonly Event[];
  llmRequestOffset: number;
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
        <section className="border-b border-border/60 bg-muted/20 px-5 py-3">
          <div className="mb-2 flex items-baseline gap-2">
            <RoleChip name="response" />
            {trace.outcome.status === "succeeded" ? (
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {trace.outcome.text.length.toLocaleString()} chars
              </span>
            ) : null}
          </div>
          {trace.outcome.status === "succeeded" ? (
            looksLikeCode(trace.outcome.text) && renderMode === "markdown" ? (
              <SourceCodeBlock
                code={trace.outcome.text}
                language="markdown"
                showLineNumbers={false}
                plainChrome
              />
            ) : (
              <Body text={trace.outcome.text} renderMode={renderMode} />
            )
          ) : trace.outcome.status === "failed" ? (
            <pre className="overflow-x-auto rounded-xl bg-destructive/5 px-4 py-2.5 font-mono text-xs leading-relaxed text-destructive">
              {trace.outcome.errorMessage}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {trace.outcome.status === "cancelled"
                ? `Cancelled${trace.outcome.reason ? ` — ${trace.outcome.reason}` : ""}`
                : "In flight…"}
            </p>
          )}
        </section>
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

function Outcome({ outcome }: { outcome: LlmTrace["outcome"] }) {
  if (outcome.status === "in flight") return <> · in flight</>;
  const duration =
    "durationMs" in outcome && outcome.durationMs != null
      ? ` in ${formatSeconds(outcome.durationMs)}`
      : "";
  return (
    <>
      {" · "}
      <span
        className={cn(
          outcome.status === "succeeded" && "text-emerald-600 dark:text-emerald-500",
          outcome.status === "failed" && "text-destructive",
          outcome.status === "cancelled" && "text-amber-600 dark:text-amber-500",
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
        name === "system" && "text-purple-700 dark:text-purple-300",
        name === "developer" && "text-purple-700/80 dark:text-purple-300/80",
        name === "user" && "text-blue-700 dark:text-blue-300",
        name === "assistant" && "text-emerald-700 dark:text-emerald-400",
        name === "response" && "text-amber-700 dark:text-amber-400",
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
              <span
                className={failed ? "text-destructive" : "text-emerald-600 dark:text-emerald-500"}
              >
                {failed ? "failed" : "succeeded"} in{" "}
                {formatSeconds(trace.settlement.atMs - trace.requestedAtMs)}
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

// ── one raw event, with Prev/Next through the log ──

function RawEventContent({
  events,
  offset,
  onInspect,
}: {
  events: readonly Event[];
  offset: number;
  onInspect: (next: Inspected) => void;
}) {
  const index = events.findIndex((event) => event.offset === offset);
  const event = events[index];
  const previous = index > 0 ? events[index - 1] : undefined;
  const next = index >= 0 ? events[index + 1] : undefined;
  if (!event)
    return (
      <SheetHeader>
        <SheetTitle>Event #{offset}</SheetTitle>
        <SheetDescription>No event at that offset on this path.</SheetDescription>
      </SheetHeader>
    );
  // Signal first: type and payload, then the rest of the envelope as the wire carried it.
  const { streamPath: _path, type, payload, offset: at, createdAt, ...rest } = event;
  const ordered = { type, payload, ...rest, offset: at, createdAt };
  return (
    <>
      <SheetHeader className="shrink-0 pr-12">
        <SheetTitle className="truncate font-mono text-base">
          #{event.offset} {shortEventType(event.type)}
        </SheetTitle>
        <SheetDescription>
          {formatDateTime(Date.parse(event.createdAt))}
          {previous
            ? ` · +${formatSeconds(Date.parse(event.createdAt) - Date.parse(previous.createdAt))} after #${String(previous.offset)}`
            : ""}
        </SheetDescription>
      </SheetHeader>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!previous}
          onClick={() => previous && onInspect({ kind: "event", offset: previous.offset })}
        >
          <ChevronLeftIcon data-icon="inline-start" /> Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!next}
          onClick={() => next && onInspect({ kind: "event", offset: next.offset })}
        >
          Next <ChevronRightIcon data-icon="inline-end" />
        </Button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {index + 1} of {events.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t p-4">
        <SerializedObjectCodeBlock data={ordered} initialFormat="yaml" showToggle showCopyButton />
      </div>
    </>
  );
}

// ── the raw log ──

function deltaColorClass(deltaMs: number): string {
  if (deltaMs < 1_000) return "text-muted-foreground/60";
  if (deltaMs < 5_000) return "text-emerald-600 dark:text-emerald-500";
  if (deltaMs < 30_000) return "text-amber-600 dark:text-amber-500";
  return "text-destructive";
}

export function EventsList({
  events,
  onOpen,
}: {
  events: readonly Event[];
  onOpen: (offset: number) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-2 md:px-6">
      {events.map((event, index) => {
        const previous = events[index - 1];
        const delta = previous ? Date.parse(event.createdAt) - Date.parse(previous.createdAt) : 0;
        return (
          <button
            key={event.offset}
            type="button"
            onClick={() => onOpen(event.offset)}
            className="flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-muted/60"
          >
            <span className="w-12 shrink-0 text-muted-foreground/60">#{event.offset}</span>
            <span className="min-w-0 flex-1 truncate">{shortEventType(event.type)}</span>
            <span className={cn("w-16 shrink-0 text-right tabular-nums", deltaColorClass(delta))}>
              {previous ? `+${formatSeconds(delta)}` : ""}
            </span>
            <span className="w-20 shrink-0 text-right text-muted-foreground/60">
              {formatClockTime(Date.parse(event.createdAt))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

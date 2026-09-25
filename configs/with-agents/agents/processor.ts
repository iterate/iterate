// agents/processor.ts — THE AGENT PROCESSOR: the pure reduce of the creation and deletion facts,
// the conversation and the loop's obligations, and the effects over that fold — THE SAGAS (the birth
// `itx.agents.create(path)` opens: the certificate on `/` and here with the default prompt beside it;
// the death `itx.agents.delete(path)` opens: the certificate on `/` and here, after which the loop
// runs no more turns) and THE LOOP (the turn loop, LLM request and codemode parts folded into one
// class, lean). The model call LIVES HERE (`#stream`): a `@cf/…` model through `itx.ai` (the
// Workers AI binding under THIS context's rules, so a test lends a fake there), anything else
// through the account's AI Gateway as a Workers AI partner model, streamed from the Responses API.
// The host (durable-object.ts) hands in `withItx` and `runModel`, the byte bridge that runs the
// model call in a loaded transport worker, so a unit test constructs the processor with `new` and
// reduces rows (processor.test.ts, in node); the saga and the loop are proven on the worker
// (e2e/agents.e2e.test.ts, a fake `itx.ai` lent by rule).
//
// A request is debounced by the at-head scheduling below: one window after its trigger,
// the failure backoff folded in, the delayed append being the intent.
//
// Two kinds of effect, chosen at the dispatch site: a PER-EVENT consequence — the assistant's
// output parsed into a script request, a script's settlement rendered into the next developer item
// — is BLOCKED (`blockProcessorWhile`): the event is delivered once, so losing the append would
// lose the consequence. A STATE-DERIVED consequence — the birth, recording the next request,
// running the open request, tripping a breaker — runs at head in the BACKGROUND: any later delivery
// over the same fold re-derives it, so an attempt lost to an eviction costs nothing, and every
// append is idempotency-keyed so a retry appends nothing twice.
import { z } from "zod";
import { errorCode } from "iterate/lib";
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/stream/processor";
import type { WithItx } from "iterate/sdk";
import type { RewriteRuleListEntry } from "iterate/api";
import type { ItxScope as ItxEntrypointScope } from "iterate/sdk";
import type { RunSettlement } from "iterate/stream/run";
import {
  AgentContract,
  type AgentState,
  type ChatMessage,
  type FileAttachment,
  type LlmUsage,
} from "./contract.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

/** THE AI GATEWAY the agent's model calls go through — `default`, the gateway Cloudflare creates on
 *  an account's first authenticated request; unified billing pays the provider, no key anywhere. A
 *  property of the code, not of a deployment. */
const AI_GATEWAY_ID = "default";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";

/** Bytes to base64, chunked so a long buffer cannot overflow the call stack's argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The failure backoff, folded into the debounce window: doubling from the policy's base per
 *  consecutive failure, capped at its ceiling; nothing after a success. */
function retryBackoffMs(state: Pick<AgentState, "consecutiveLlmFailures" | "config">): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
}

/** The conversation as the model reads it. An item's images become image parts (a data: URL of the
 *  bytes in `images`, keyed by path — a vision model sees the pixels); any other attachment, or an
 *  image whose bytes are gone, is a line naming it and how a script reads it (a hint line).
 *  The developer's notes read as system instructions. */
export function buildChatMessages(
  items: AgentState["contextItems"],
  images: Map<string, { contentType: string; base64: string }>,
  tree: RewriteRuleListEntry[] = [],
): ChatMessage[] {
  const messages = items.map((item): ChatMessage => {
    const role = item.role === "developer" ? "system" : item.role;
    if (!item.files?.length) return { role, content: item.content };
    const parts: Extract<ChatMessage["content"], unknown[]> = [];
    const hints: string[] = [];
    for (const file of item.files) {
      const image = images.get(file.path);
      if (image)
        parts.push({
          type: "image_url",
          image_url: { url: `data:${image.contentType};base64,${image.base64}` },
        });
      else hints.push(fileHintLine(file));
    }
    const text = [item.content, ...hints].filter((line) => line !== "").join("\n");
    if (parts.length === 0) return { role, content: text };
    return { role, content: [{ type: "text", text }, ...parts] };
  });
  // THE TREE this turn — the sandbox's `rewriteRules.list()`, rendered — as one system message after
  // the journaled system items, before the conversation: what the model's scripts can spell.
  const rendered = renderCapabilityTree(tree);
  if (rendered) {
    const firstNonSystem = messages.findIndex((message) => message.role !== "system");
    messages.splice(firstNonSystem === -1 ? messages.length : firstNonSystem, 0, {
      role: "system",
      content: rendered,
    });
  }
  return messages;
}

/** The sandbox's table as the model reads it: one line per name it can spell (`match — description`,
 *  a row without a description shows its target), grouped by the context each row came from when
 *  more than one; masks and the bare `itx` row are not names. Null when nothing is spellable (a jail
 *  with no grants yet): then no tree message at all. */
export function renderCapabilityTree(rows: RewriteRuleListEntry[]): string | null {
  const visible = rows.filter((row) => row.target && row.match !== "itx");
  if (visible.length === 0) return null;
  const contexts = [...new Set(visible.map((row) => row.context))];
  const body = contexts.flatMap((context) => [
    `from ${context}:`,
    ...visible
      .filter((row) => row.context === context)
      .map((row) => `${row.match} — ${row.description || `⇒ ${row.target}`}`),
  ]);
  return [
    "`itx` IS THIS CONTEXT'S CAPABILITY TREE (`await itx.rewriteRules.list()`) — every name below is one you can spell inside a tag; nothing else resolves:",
    ...body,
  ].join("\n");
}

/** How a non-image (or gone) attachment is named to the model. */
function fileHintLine(file: FileAttachment): string {
  return `[Attached file: ${file.filename} (${file.contentType}, ${String(file.size)} bytes) — read it with \`await itx.files.get(${JSON.stringify(file.path)}).bytes()\`]`;
}

/** The chunk-coalescing window: how much streamed output rides one `llm-response-frame`
 *  append — ~7 repaints a second, and one commit per window instead of per token. */
const CHUNK_WINDOW_MS = 150;
/** A window that grew past this lands early rather than as one oversized append. */
const CHUNK_WINDOW_MAX_CHARS = 64_000;
/** The idle watchdog: a stream that carries nothing for this long fails the attempt, so a stalled
 *  provider never wedges a turn until its expiry. The host's byte transport times out on the same
 *  budget. */
export const STREAM_IDLE_BUDGET_MS = 45_000;

/** The context windows of the models this loop names; a conservative floor for the rest. OpenAI's
 *  figures are the operating window (where pricing doubles), not the documented one. */
function contextWindowTokens(model: string): number {
  if (/^gpt-(6|5)/.test(model)) return 272_000;
  if (model.startsWith("@cf/meta/llama-4-scout")) return 131_072;
  return 128_000;
}

/** The abort reason an interruption carries, so the runner tells it from a clock. */
class InterruptedError extends Error {
  constructor() {
    super("interrupted by the person's next words");
    this.name = "InterruptedError";
  }
}

/** An append that may LOSE to an earlier one under the same idempotency key with a different
 *  body — the settle of a request an interruption already settled — and then appends nothing:
 *  the first settlement stands, the later one was never a fact. */
async function appendUnlessLost(
  append: AgentArgs["append"],
  ...events: AgentEmitted[]
): Promise<void> {
  try {
    await append(...events);
  } catch (error) {
    if (!/idempotency key .* already names a different event/.test(String(error))) throw error;
  }
}

// ── the model call's wire shapes ──

/** What Workers AI answers when it does not stream: `{ response }`, or the chat-completions shape. */
const ChatAnswer = z.union([
  z.object({ response: z.string() }),
  z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }),
]);

/** The usage a provider reports, both dialects: OpenAI Responses
 *  (`input_tokens`/`output_tokens`) and chat completions (`prompt_tokens`/`completion_tokens`),
 *  with the cached/reasoning breakdowns when present. Loose: vendors keep adding fields. */
const ProviderUsage = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  input_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  output_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

function normalizeUsage(raw: unknown): LlmUsage | undefined {
  const parsed = ProviderUsage.safeParse(raw);
  if (!parsed.success) return undefined;
  const inputTokens = parsed.data.prompt_tokens ?? parsed.data.input_tokens;
  const outputTokens = parsed.data.completion_tokens ?? parsed.data.output_tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens =
    parsed.data.prompt_tokens_details?.cached_tokens ??
    parsed.data.input_tokens_details?.cached_tokens;
  const reasoningOutputTokens =
    parsed.data.completion_tokens_details?.reasoning_tokens ??
    parsed.data.output_tokens_details?.reasoning_tokens;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens };
}

/** One OpenAI Responses API stream event — the ones this loop reads; the rest pass through as
 *  chunks a feed may ignore. */
const ResponsesEvent = z.looseObject({ type: z.string() });

/** Read an SSE body frame by frame, handing each `data:` JSON to `onEvent`; the reader is cancelled
 *  when `signal` aborts, so nothing lands after the caller has settled. */
async function drainSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  let completed = false;
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      event = data;
    }
    onEvent(event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() || "";
      frames.forEach(frame);
    }
    buffered += decoder.decode();
    if (buffered.trim()) frame(buffered);
    completed = true;
  } finally {
    signal.removeEventListener("abort", cancel);
    // A parser error (for example, a `response.failed` event) stops this consumer before the
    // producer has necessarily finished.  Cancel the local body in that case: otherwise the
    // byte bridge can be left waiting forever on its next backpressured write.
    // Do not await this cancellation. The producer may be awaiting the write whose chunk this
    // reader just rejected, and awaiting both sides would turn the error path into a deadlock.
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** The conversation as the Responses API takes it: `input` items with text and image parts. */
function responsesInput(messages: ChatMessage[]) {
  return messages.map((message) =>
    typeof message.content === "string"
      ? { role: message.role, content: message.content }
      : {
          role: message.role,
          content: message.content.map((part) =>
            part.type === "text"
              ? { type: "input_text", text: part.text }
              : { type: "input_image", image_url: part.image_url.url, detail: "auto" },
          ),
        },
  );
}

type AgentEvent = ConsumedEvent<typeof AgentContract>;
type AgentArgs = ProcessEventArgs<AgentState, AgentEvent, AgentEmitted>;
/** What the loop appends: each type the contract emits, its payload as the catalog spells it. */
type AgentEmitted = EmittedEventInput<typeof AgentContract>;

/** A settlement as the model reads it next — or null when the script returned nothing: the turn ends. */
export function renderScriptSettlement(settlement: RunSettlement): string | null {
  if (settlement.status === "failed")
    return `Your script failed (${settlement.failureKind}):\n\`\`\`\n${settlement.error}\n\`\`\``;
  if (settlement.result === undefined) return null;
  return `Your script returned:\n\`\`\`json\n${JSON.stringify(settlement.result, null, 2)}\n\`\`\``;
}

type AgentProcessorDeps = {
  /** The host's scope accessor: `itx.ai`, `itx.files`, `itx.whoami()` — the effects this loop
   *  reaches through the context, under its rules (a test lends a fake `itx.ai` there). */
  withItx: WithItx<ItxEntrypointScope>;
  /** The host bridges raw provider bodies through awaited byte RPC. */
  runModel(
    path: string,
    model: string,
    input: unknown,
    options: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** The clock and the wait, injected only so a unit test can make the debounce instant. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class AgentProcessor extends StreamProcessor<AgentState, AgentEvent> {
  readonly contract = AgentContract;

  private readonly deps: AgentProcessorDeps;
  readonly #now: () => number;
  /** The debounce window's wait — a test makes it instant. */
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: AgentProcessorDeps) {
    super();
    this.deps = deps;
    this.#now = deps.now || (() => Date.now());
    this.#sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** This incarnation's birth attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.creation`. */
  #creating = false;
  /** The same for this incarnation's death attempt; the durable ground is `state.deletion`. */
  #deleting = false;

  /** The requests THIS incarnation is running, so a later at-head pass over the same fold does
   *  not start a second attempt; the durable ground is the fold (`openRequest`). */
  readonly #llmRequestsInFlight = new Map<
    number,
    { controller: AbortController; partialText: string }
  >();

  #identityRead?: { projectId: string; path: string };
  /** Which context this is — its project and path — read once. */
  async #identity(): Promise<{ projectId: string; path: string }> {
    return (this.#identityRead ??= await this.deps.withItx((itx) => itx.whoami()));
  }

  /** Every change the facts make is stamped with the event's time: `lastActivityAt` moves exactly
   *  when the state does, so a harmless fact (a late intent, a repeated certificate) never reorders
   *  the sidebar. */
  reduce(args: ReduceArgs<AgentState, AgentEvent>): AgentState | undefined {
    const next = this.#reduceFacts(args);
    return next && { ...next, lastActivityAt: args.event.createdAt };
  }

  #reduceFacts({ state, event }: ReduceArgs<AgentState, AgentEvent>): AgentState | undefined {
    switch (event.type) {
      case "events.iterate.com/agent/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new
        // attempt. A deleted agent is not re-creatable: `creation` stays as it was, so the request
        // is a harmless fact there too (the collection refuses it before it lands).
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: { status: "requested", offset: event.offset },
            };
      case "events.iterate.com/agent/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/agent/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/agent/delete-requested":
        // Dies once: a request after the death certificate is a harmless fact. Deletion never
        // touches `creation` — the log still says the agent was born.
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case "events.iterate.com/agent/deleted":
        return { ...state, deletion: { status: "deleted", offset: event.offset } };

      case "events.iterate.com/agent/configured": {
        const patch = event.payload.config;
        return {
          ...state,
          config: {
            llm: { model: patch.llm?.model ?? state.config.llm.model },
            maxAutonomousTurns: patch.maxAutonomousTurns ?? state.config.maxAutonomousTurns,
            llmRequestExpiryMs: patch.llmRequestExpiryMs ?? state.config.llmRequestExpiryMs,
            llmRequestDebounceMs: patch.llmRequestDebounceMs ?? state.config.llmRequestDebounceMs,
            llmRequestRetryPolicy: {
              maxAttempts:
                patch.llmRequestRetryPolicy?.maxAttempts ??
                state.config.llmRequestRetryPolicy.maxAttempts,
              backoffBaseMs:
                patch.llmRequestRetryPolicy?.backoffBaseMs ??
                state.config.llmRequestRetryPolicy.backoffBaseMs,
              backoffMaxMs:
                patch.llmRequestRetryPolicy?.backoffMaxMs ??
                state.config.llmRequestRetryPolicy.backoffMaxMs,
            },
          },
        };
      }

      case "events.iterate.com/agent/context-added": {
        const { role, content, actor, llmRequestPolicy, llmRequestOffset } = event.payload;
        const next: AgentState = {
          ...state,
          contextItems: [
            ...state.contextItems,
            {
              offset: event.offset,
              role,
              content,
              actor,
              llmRequestOffset,
              files: event.payload.files,
            },
          ],
        };
        // A person's or a developer's words raise the trigger — the system prompt and the
        // assistant's own output never do, nor words whose policy says not to.
        const triggers =
          (role === "user" || role === "developer") &&
          llmRequestPolicy?.behaviour !== "dont-trigger-request";
        if (!triggers) return next;
        const source =
          actor?.type === "script" || actor?.type === "agent" ? "agent-loop" : "external";
        return {
          ...next,
          pendingLlmRequestTrigger: {
            offset: event.offset,
            atMs: Date.parse(event.createdAt),
            source,
          },
          ...(source === "external" && { autonomousTurnCount: 0 }),
        };
      }

      case "events.iterate.com/agent/llm-request-requested": {
        // A late intent — its trigger answered, moved on, or a request already open — is a harmless
        // stream fact: only the intent naming THE pending trigger opens a request, so a sleep the
        // debounce left behind for a trigger that moved can neither skip the new trigger's window
        // nor a failure's backoff. The request's identity is the offset of the intent that opened it.
        const trigger = state.pendingLlmRequestTrigger;
        if (!trigger || state.openRequest || trigger.offset !== event.payload.triggerOffset)
          return undefined;
        return {
          ...state,
          pendingLlmRequestTrigger: null,
          openRequest: {
            requestedAtOffset: event.offset,
            expiresAt: event.payload.expiresAt,
            model: event.payload.model,
            triggerSource: trigger.source,
          },
          autonomousTurnCount:
            trigger.source === "agent-loop"
              ? state.autonomousTurnCount + 1
              : state.autonomousTurnCount,
        };
      }

      case "events.iterate.com/agent/llm-request-settled": {
        const open = state.openRequest;
        if (!open || open.requestedAtOffset !== event.payload.requestOffset) return undefined;
        const { result } = event.payload;
        if (result.status === "succeeded")
          return { ...state, openRequest: null, consecutiveLlmFailures: 0 };
        if (result.status === "failed")
          // The trigger comes back for the retry, still the same source; the pass caps the retries.
          return {
            ...state,
            openRequest: null,
            consecutiveLlmFailures: state.consecutiveLlmFailures + 1,
            pendingLlmRequestTrigger: {
              offset: open.requestedAtOffset,
              atMs: Date.parse(event.createdAt),
              source: open.triggerSource,
            },
          };
        // Expired: the turn is dropped; the person's next words start fresh.
        return { ...state, openRequest: null };
      }

      case "events.iterate.com/agent/paused":
        // A pause DROPS the parked trigger: what tripped the breaker (a script's result, a retry)
        // must not be what resumes it. Only words that arrive after the pause raise a new one.
        return state.paused
          ? undefined
          : {
              ...state,
              paused: { reason: event.payload.reason, atOffset: event.offset },
              pendingLlmRequestTrigger: null,
            };

      case "events.iterate.com/agent/resumed":
        return state.paused
          ? { ...state, paused: null, autonomousTurnCount: 0, consecutiveLlmFailures: 0 }
          : undefined;

      default:
        return undefined;
    }
  }

  processEvent(args: AgentArgs): undefined {
    const { event, state, append, blockProcessorWhile } = args;
    // An agent asked to go acts no more: no consequence of a late event (a script result landing
    // after the request raises no turn), no interrupt to settle — only the death itself, at head.
    if (state.deletion) {
      this.#atHead(args);
      return;
    }
    // THE INTERRUPT: cancellation is a property of new input, never a command. The
    // person's words abort whatever this incarnation is streaming, keep what streamed as an
    // assistant item the next turn can see (no llmRequestOffset: a record, never parsed for a
    // script), and settle the request cancelled — blocked, so an eviction can never leave the
    // request open for the next at-head pass to adopt. Their reduce already moved the trigger; the
    // settlement's own delivery re-runs the at-head pass, which then records the next request.
    if (
      event?.type === "events.iterate.com/agent/context-added" &&
      event.payload.llmRequestPolicy?.behaviour === "interrupt-current-request" &&
      (event.payload.role === "user" || event.payload.role === "developer") &&
      state.openRequest
    ) {
      const open = state.openRequest;
      const inFlight = this.#llmRequestsInFlight.get(open.requestedAtOffset);
      inFlight?.controller.abort(new InterruptedError());
      const partialText = inFlight?.partialText || undefined;
      blockProcessorWhile(() =>
        appendUnlessLost(
          append,
          ...(partialText
            ? [
                {
                  type: "events.iterate.com/agent/context-added",
                  idempotencyKey: this.idempotencyKey(
                    `interrupted/${String(open.requestedAtOffset)}`,
                  ),
                  payload: {
                    role: "assistant",
                    content: `[Response interrupted by the user's next message; partial output follows]\n${partialText}`,
                  },
                } satisfies AgentEmitted,
              ]
            : []),
          {
            type: "events.iterate.com/agent/llm-request-settled",
            idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
            payload: {
              requestOffset: open.requestedAtOffset,
              result: { status: "cancelled", reason: "interrupted-by-user-input", partialText },
            },
          },
        ),
      );
      // Not at head this frame: the pass reads the pre-cancel fold and would adopt the very
      // request the queued settlement cancels.
      return;
    }

    // ── per-event consequences, blocked: the event is delivered once ──
    // The assistant's answer, interpreted (mmkal's order: the status precedes the script so the step
    // is born with its label, the script precedes the prose so a feed groups the turn as one).
    if (
      event?.type === "events.iterate.com/agent/context-added" &&
      event.payload.role === "assistant" &&
      event.payload.llmRequestOffset !== undefined
    ) {
      const { llmRequestOffset } = event.payload;
      const outcome = parseCodemodeResponse(event.payload.content);
      const consequences: AgentEmitted[] = [];
      if (outcome.kind === "malformed" || outcome.kind === "multiple")
        consequences.push({
          type: "events.iterate.com/agent/context-added",
          idempotencyKey: this.idempotencyKey("format-feedback", event),
          payload: { role: "developer", content: outcome.feedback, actor: { type: "agent" } },
        });
      if (outcome.kind === "script") {
        if (outcome.status)
          consequences.push({
            type: "events.iterate.com/agent/summary-updated",
            idempotencyKey: this.idempotencyKey("codemode-status", event),
            payload: { activity: outcome.status },
          });
        consequences.push({
          type: "events.iterate.com/itx/run-requested",
          idempotencyKey: this.idempotencyKey("run-requested", event),
          payload: { code: outcome.code },
        });
      }
      // The prose — beside a tag or on its own — is the message, appended directly on this context.
      // Where a reply GOES from here is a subscriber's business (events are the interface), never a
      // script the model's sandbox would need a row for.
      if ((outcome.kind === "script" || outcome.kind === "none") && outcome.prose)
        consequences.push({
          type: "events.iterate.com/agent/web-message-sent",
          idempotencyKey: this.idempotencyKey("codemode-prose", event),
          payload: { message: outcome.prose, llmRequestOffset },
        });
      if (consequences.length > 0) blockProcessorWhile(() => append(...consequences));
    }

    // THE CONTEXT ran the script (whoever asked — this loop, or anything else on this context);
    // its settlement is the model's next input.
    if (event?.type === "events.iterate.com/itx/run-settled") {
      const rendered = renderScriptSettlement(event.payload.settlement);
      if (rendered)
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/context-added",
            idempotencyKey: this.idempotencyKey("script-result", event),
            payload: {
              role: "developer",
              content: rendered,
              actor: { type: "script", requestOffset: event.payload.requestOffset },
            },
          }),
        );
    }

    this.#atHead(args);
  }

  // ── state-derived consequences, at head, in the background: re-derived by any later delivery ──
  #atHead({ state, delivery, append, runInBackground }: AgentArgs): void {
    if (!delivery.caughtUp) return;

    // THE SAGA — the birth, from state at head, in the background: at most once per incarnation,
    // and any later delivery over the same state runs it again, so an attempt lost to an eviction
    // costs nothing. Nothing to provision: the certificate goes to `/` (the project catalog) first,
    // then lands here in ONE append with the default system prompt beside it — both keyed, so a
    // retry appends nothing twice. An operator's instructions are their own `context-added` after.
    if (state.creation?.status === "requested") {
      if (this.#creating) return;
      this.#creating = true;
      runInBackground(async () => {
        try {
          const whoami = await this.deps.withItx((itx) => itx.whoami());
          const { path } = whoami;
          const certificate: AgentEmitted = {
            type: "events.iterate.com/agent/created",
            payload: { path },
            idempotencyKey: `agent/created:${path}`,
          };
          await this.deps.withItx((itx) =>
            itx.invoke(["itx", "agents", ["announce", certificate]]),
          ); // the project catalog first
          await append(certificate, {
            // this path last: the certificate closes the obligation, the prompt rides with it
            type: "events.iterate.com/agent/context-added",
            idempotencyKey: `agent/system-prompt:${path}`,
            payload: {
              role: "system",
              content: `${DEFAULT_AGENT_SYSTEM_PROMPT}\nCURRENT PROJECT: ${JSON.stringify(whoami)}`,
            },
          });
        } catch (error) {
          await append({
            type: "events.iterate.com/agent/create-failed",
            payload: { error: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          this.#creating = false;
        }
      });
      return;
    }
    if (state.creation?.status !== "created") return;

    // THE DEATH — the birth's mirror, only of an agent that was born, and the LOOP's gate: a deleted
    // agent (or one asked to go) runs no more turns, whatever the fold below says. Nothing to tear
    // down, so the saga is the death certificate alone: `/` first (the catalog drops the entry), then
    // here — keyed, so a retry appends nothing twice. A throw appends nothing: the next at-head pass
    // is the retry, and there is no delete-failed fact.
    if (state.deletion) {
      if (state.deletion.status !== "requested" || this.#deleting) return;
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const { path } = await this.#identity();
          const certificate: AgentEmitted = {
            type: "events.iterate.com/agent/deleted",
            payload: { path },
            idempotencyKey: `agent/deleted:${path}`,
          };
          await this.deps.withItx((itx) =>
            itx.invoke(["itx", "agents", ["announce", certificate]]),
          ); // the project catalog first
          await append(certificate); // this path last: closes the obligation
        } finally {
          this.#deleting = false;
        }
      });
      return;
    }
    const now = this.#now();

    // A person's words resume a paused loop; the loop's own never do (they are what paused it).
    const trigger = state.pendingLlmRequestTrigger;
    if (state.paused && trigger?.source === "external") {
      runInBackground(() =>
        append({
          type: "events.iterate.com/agent/resumed",
          idempotencyKey: this.idempotencyKey(`resume/${String(trigger.offset)}`),
          payload: { reason: "external input" },
        }),
      );
      return;
    }

    // A trigger and nothing open: record the request — or trip a breaker instead.
    if (trigger && !state.openRequest && !state.paused) {
      const { maxAutonomousTurns, llmRequestRetryPolicy, llmRequestExpiryMs, llm } = state.config;
      const breaker =
        trigger.source === "agent-loop" && state.autonomousTurnCount >= maxAutonomousTurns
          ? `autonomous turn limit reached (${String(maxAutonomousTurns)} consecutive turns without external input)`
          : state.consecutiveLlmFailures >= llmRequestRetryPolicy.maxAttempts
            ? `the model failed ${String(state.consecutiveLlmFailures)} times in a row`
            : null;
      if (breaker) {
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/paused",
            idempotencyKey: this.idempotencyKey(`pause/${String(trigger.offset)}`),
            payload: { reason: breaker, triggerOffset: trigger.offset },
          }),
        );
        return;
      }
      // THE DEBOUNCE: wait for more content, plus the failure backoff — one window,
      // anchored at the trigger. The delayed append IS the intent (no wake event): more words inside
      // the window move the trigger; the old trigger's intent then lands as a harmless fact (the
      // reduce opens a request only for the trigger it names) and the moved trigger's own intent, a
      // window later, opens the one request for them all — the prompt is built from the log at run
      // time. Every at-head pass inside the window schedules another
      // sleep-then-append for the same trigger, so the body is DETERMINISTIC from trigger + config
      // (expiresAt anchored at the trigger's time, never `now`): identical bodies dedupe on the key.
      // A droppable attempt: dying mid-window, the revival pass re-runs this with the window long
      // closed and appends at once.
      const windowMs = state.config.llmRequestDebounceMs + retryBackoffMs(state);
      const windowClosesInMs = trigger.atMs + windowMs - now;
      const intent: AgentEmitted = {
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: this.idempotencyKey(`request/${String(trigger.offset)}`),
        payload: {
          model: llm.model,
          expiresAt: trigger.atMs + llmRequestExpiryMs,
          triggerOffset: trigger.offset,
        },
      };
      runInBackground(async () => {
        if (windowClosesInMs > 0) await this.#sleep(windowClosesInMs);
        await append(intent);
      });
      return;
    }

    // An open request nobody HERE is running: run it — the first time and after an eviction are the
    // same path (the engine's revive wakes a dead context while an attempt is in flight; the wake's
    // push lands here) — or settle it expired.
    const open = state.openRequest;
    if (open && !this.#llmRequestsInFlight.has(open.requestedAtOffset)) {
      if (now >= open.expiresAt)
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/llm-request-settled",
            idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
            payload: {
              requestOffset: open.requestedAtOffset,
              result: { status: "cancelled", reason: "expired" },
            },
          }),
        );
      else {
        const inFlight = { controller: new AbortController(), partialText: "" };
        this.#llmRequestsInFlight.set(open.requestedAtOffset, inFlight);
        runInBackground(() => this.#runLlmRequest(open, state, append, inFlight));
      }
    }
  }

  /** The model over the conversation up to the request, STREAMED: each coalescing window of provider
   *  events is one ephemeral `llm-response-frame` (a feed renders the answer as it is written); ONE
   *  batch then settles the request, lands the assistant's words and reports the cost, so an eviction
   *  between them is impossible. An interruption settles the request itself (processEvent) — an
   *  aborted stream ends here silently, and a success that raced it loses on the settle key. */
  async #runLlmRequest(
    open: NonNullable<AgentState["openRequest"]>,
    state: AgentState,
    append: AgentArgs["append"],
    inFlight: { controller: AbortController; partialText: string },
  ): Promise<void> {
    const startedAt = this.#now();
    const { controller } = inFlight;
    // Two clocks fail a stalled stream, never wedge it: the request's own expiry, and the idle
    // budget since the last provider event.
    const expiry = setTimeout(
      () => controller.abort(new Error("the model did not finish before the request expired")),
      Math.max(1_000, open.expiresAt - startedAt),
    );
    let idle = setTimeout(
      () => controller.abort(new Error("the model stream stalled")),
      STREAM_IDLE_BUDGET_MS,
    );
    try {
      const { path } = await this.#identity();
      const tree = await this.deps
        .withItx((itx) => itx.cd(`${path}/sandbox`).rewriteRules.list())
        .catch((error: unknown) => {
          // A fully masked sandbox deliberately denies introspection too. Give the model no
          // advertised tools; prose replies still work. Transport/runtime failures remain errors.
          if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") return [];
          throw error;
        });
      const items = state.contextItems.filter((item) => item.offset < open.requestedAtOffset);
      // The images the model will see: read now, the freshest bytes at the request; one that is
      // gone (deleted meanwhile) is named instead of shown.
      const images = new Map<string, { contentType: string; base64: string }>();
      for (const item of items)
        for (const file of item.files || []) {
          if (!file.contentType.startsWith("image/") || images.has(file.path)) continue;
          try {
            images.set(file.path, {
              contentType: file.contentType,
              base64: bytesToBase64(
                await this.deps.withItx((itx) => itx.files.get(file.path).bytes()),
              ),
            });
          } catch {
            // named by its hint line instead
          }
        }
      const messages = buildChatMessages(items, images, tree);
      // THE CHUNK WINDOWS: provider events pile into one buffer; a window
      // closes CHUNK_WINDOW_MS after its first event (or at the size cap) and lands as one
      // ephemeral append, windows in order — each waits for the one before. Nothing is stored:
      // the settlement below carries the durable text.
      const llmRequestOffset = open.requestedAtOffset;
      let window: unknown[] = [];
      let windowChars = 0;
      let windowOpen = false;
      let sequence = 0;
      let windows: Promise<void> = Promise.resolve();
      const closeWindow = () => {
        windowOpen = false;
        if (window.length === 0) return;
        const chunks = window;
        window = [];
        windowChars = 0;
        const payload = { llmRequestOffset, chunks, sequence: sequence++ };
        windows = windows
          .then(() =>
            append({
              type: "events.iterate.com/agent/llm-response-frame",
              ephemeral: true,
              payload,
            }),
          )
          .then(
            () => undefined,
            () => undefined, // a lost window loses only its repaint; the settlement is the truth
          );
      };
      const settle = async (
        result: Extract<
          AgentEvent,
          { type: "events.iterate.com/agent/llm-request-settled" }
        >["payload"]["result"],
        ...alongside: AgentEmitted[]
      ) => {
        closeWindow();
        await windows; // every window before the terminal fact
        await appendUnlessLost(
          append,
          {
            type: "events.iterate.com/agent/llm-request-settled",
            idempotencyKey: this.idempotencyKey(`settle/${String(llmRequestOffset)}`),
            payload: {
              requestOffset: llmRequestOffset,
              durationMs: this.#now() - startedAt,
              result,
            },
          },
          ...alongside,
        );
      };
      let answer: { text: string; usage?: LlmUsage };
      try {
        answer = await this.#stream({
          model: open.model,
          messages,
          signal: controller.signal,
          onChunk: (chunk, textDelta) => {
            if (controller.signal.aborted) return;
            clearTimeout(idle);
            idle = setTimeout(
              () => controller.abort(new Error("the model stream stalled")),
              STREAM_IDLE_BUDGET_MS,
            );
            // The partial accrues BEFORE buffering: an interrupt keeps the whole streamed text even
            // when its last window never landed.
            inFlight.partialText += textDelta;
            window.push(chunk);
            windowChars += JSON.stringify(chunk).length;
            if (windowChars >= CHUNK_WINDOW_MAX_CHARS) return closeWindow();
            if (windowOpen) return;
            windowOpen = true;
            void this.#sleep(CHUNK_WINDOW_MS).then(closeWindow);
          },
        });
      } catch (error) {
        // The interrupt path's story — it settled the request itself.
        if (controller.signal.reason instanceof InterruptedError) return;
        // `#stream` can reject after it has handed the byte transport a local Response (for
        // example, on an in-band provider failure). Stop that producer before recording the
        // settlement, rather than leaving its next backpressured write alive in waitUntil.
        controller.abort(error);
        await settle({
          status: "failed",
          errorMessage: String(error instanceof Error ? error.message : error).slice(0, 4_000),
          partialText: inFlight.partialText || undefined,
        });
        return;
      }
      // An answer that arrived after the interruption is the interrupt path's story too.
      if (controller.signal.reason instanceof InterruptedError) return;
      const { text, usage } = answer;
      await settle(
        { status: "succeeded", text, usage },
        {
          type: "events.iterate.com/agent/context-added",
          idempotencyKey: this.idempotencyKey(`assistant/${String(llmRequestOffset)}`),
          payload: { role: "assistant", content: text, llmRequestOffset },
        },
        ...(usage
          ? [
              {
                type: "events.iterate.com/agent/token-usage-reported",
                idempotencyKey: this.idempotencyKey(`usage/${String(llmRequestOffset)}`),
                payload: {
                  model: open.model,
                  maxContextTokens: contextWindowTokens(open.model),
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                },
              } satisfies AgentEmitted,
            ]
          : []),
      );
    } finally {
      clearTimeout(expiry);
      clearTimeout(idle);
      this.#llmRequestsInFlight.delete(open.requestedAtOffset);
    }
  }

  /** One STREAMED model call over the conversation so far: every provider event the stream carries
   *  reaches `onChunk` as it arrives, with the text it adds ("" for a reasoning or bookkeeping
   *  event); the call answers the whole text once the stream ends, with the usage the provider
   *  reported. Aborting `signal` stops the stream; the call then rejects.
   *
   *  Two routes by the model's name. The host invokes Workers AI under this context's rules and
   *  relays any raw body through an app-owned byte transport. A `@cf/…` answer may be streamed or
   *  whole JSON.
   *  Anything else is OpenAI's Responses API as a Workers AI partner model on Cloudflare's billing
   *  — no key, ours or a project's — the FAST reading of a reasoning model: low effort, with its
   *  summary streamed. */
  async #stream({
    model,
    messages,
    signal,
    onChunk,
  }: {
    model: string;
    messages: ChatMessage[];
    signal: AbortSignal;
    onChunk(chunk: unknown, textDelta: string): void;
  }): Promise<{ text: string; usage?: LlmUsage }> {
    if (model.startsWith("@cf/")) {
      // The model is configuration, so the transport result is validated below rather than trusted.
      const { path } = await this.#identity();
      const raw: unknown = await this.deps.runModel(
        path,
        model,
        { messages, stream: true },
        undefined,
        signal,
      );
      if (raw instanceof ReadableStream) {
        let text = "";
        let usage: LlmUsage | undefined;
        await drainSse(raw, signal, (event) => {
          const chunk = z.looseObject({ response: z.string().optional() }).safeParse(event);
          const delta = chunk.success ? chunk.data.response || "" : "";
          text += delta;
          onChunk(event, delta);
          const reported = z.looseObject({ usage: z.unknown() }).safeParse(event);
          if (reported.success && reported.data.usage !== undefined)
            usage = normalizeUsage(reported.data.usage) ?? usage;
        });
        if (text.trim() === "") throw new Error("the model answered with no text");
        return { text: text.trim(), usage };
      }
      // A binding (or a lent fake) that answered whole: the one chunk there is.
      const answer = ChatAnswer.parse(raw);
      const text = (
        "response" in answer ? answer.response : answer.choices[0]!.message.content
      ).trim();
      if (text === "") throw new Error("the model answered with no text");
      onChunk(raw, text);
      return { text };
    }
    // No key of ours rides this request: an `openai/…` model is a Workers AI PARTNER model, billed
    // by Cloudflare through the binding — the Responses API shape, streamed, the raw Response asked
    // for so the SSE body is ours to read. The gateway option routes it through the account's AI
    // Gateway; its metadata (project, stream path, context) is what the gateway's spend limits
    // partition on, so a runaway agent hits ITS ceiling. Nothing is trusted from the answer: it is a
    // Response checked for status and parsed event by event below.
    const { projectId, path } = await this.#identity();
    const raw: unknown = await this.deps.runModel(
      path,
      `openai/${model}`,
      {
        input: responsesInput(messages),
        stream: true,
        store: false,
        reasoning: { effort: "low", summary: "auto" },
      },
      {
        returnRawResponse: true,
        gateway: {
          id: AI_GATEWAY_ID,
          skipCache: true,
          metadata: { projectId, streamPath: path, context: "agent-turn" },
        },
      },
      signal,
    );
    if (!(raw instanceof Response))
      throw new Error(`model ${model}: Workers AI did not answer with the raw response`);
    const response = raw;
    if (!response.ok || !response.body)
      throw new Error(
        `openai/${model} ${String(response.status)}: ${(await response.text()).slice(0, 400)}`,
      );
    let text = "";
    let usage: LlmUsage | undefined;
    await drainSse(response.body, signal, (raw) => {
      const event = ResponsesEvent.safeParse(raw);
      if (!event.success) return;
      const { type } = event.data;
      if (type === "response.output_text.delta") {
        const delta = typeof event.data.delta === "string" ? event.data.delta : "";
        text += delta;
        onChunk(raw, delta);
      } else if (type === "response.reasoning_summary_text.delta") onChunk(raw, "");
      else if (type === "response.completed" || type === "response.incomplete") {
        const done = z
          .looseObject({ response: z.looseObject({ usage: z.unknown() }) })
          .safeParse(raw);
        if (done.success) usage = normalizeUsage(done.data.response.usage) ?? usage;
      } else if (type === "response.failed" || type === "error") {
        const failure = z
          .looseObject({
            error: z.looseObject({ message: z.string() }).optional(),
            response: z
              .looseObject({ error: z.looseObject({ message: z.string() }).optional() })
              .optional(),
          })
          .safeParse(raw);
        throw new Error(
          `openai: ${failure.success ? failure.data.error?.message || failure.data.response?.error?.message || type : type}`,
        );
      }
    });
    if (text.trim() === "") throw new Error("the model answered with no text");
    return { text: text.trim(), usage };
  }
}

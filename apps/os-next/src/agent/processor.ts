// src/agent/processor.ts — the agent processor (the triplet's middle): the pure reduce of the
// conversation and the loop's two obligations, and the loop itself as effects over that fold — apps/os's
// turn loop, LLM request and codemode parts folded into one class, lean. Imports only the pure kernel,
// so a unit test constructs it with `new` (processor.test.ts, in node); the model and the script runner
// come in as functions (`AgentDeps`) — the host (durable-object.ts) reaches both through `itx`.
//
// A request is DEBOUNCED as in apps/os (the at-head scheduling below): one window after its trigger,
// the failure backoff folded in, the delayed append being the intent.
//
// Two kinds of effect, chosen at the dispatch site (apps/os's rule): a PER-EVENT consequence — the
// assistant's output parsed into a script request, a script's settlement rendered into the next
// developer item — is BLOCKED (`blockProcessorWhile`): the event is delivered once, so losing the
// append would lose the consequence. A STATE-DERIVED consequence — recording the next request, running
// the open request or the open scripts, tripping a breaker — runs at head in the BACKGROUND: any later
// delivery over the same fold re-derives it, so an attempt lost to an eviction costs nothing, and every
// append is idempotency-keyed so a retry appends nothing twice.
import type { RewriteRuleListEntry } from "iterate/next/api";
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "iterate/next/stream/processor";
import {
  AgentContract,
  type AgentView,
  type ChatMessage,
  type FileAttachment,
  type LlmUsage,
} from "./contract.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

/** What the host injects: the model and the script runner, both reached through `itx` there. */
export type AgentDeps = {
  /** One STREAMED model call over the conversation so far: every provider event the stream carries
   *  reaches `onChunk` as it arrives, with the text it adds ("" for a reasoning or bookkeeping
   *  event); the call answers the whole text once the stream ends, with the usage the provider
   *  reported. Aborting `signal` stops the stream; the call then rejects. */
  stream(input: {
    model: string;
    messages: ChatMessage[];
    signal: AbortSignal;
    onChunk(chunk: unknown, textDelta: string): void;
  }): Promise<{ text: string; usage?: LlmUsage }>;
  /** Run `async (itx) => …` in this agent's sandbox; what it returned (JSON), or a throw. */
  runScript(code: string): Promise<unknown>;
  /** The sandbox's `rewriteRules.list()` — the tree the model is shown this turn. */
  rewriteRules(): Promise<RewriteRuleListEntry[]>;
  /** A stored file's bytes (`itx.files.get(path).bytes()`); throws when it is gone. */
  readFile(path: string): Promise<Uint8Array>;
  now(): number;
  /** The debounce window's wait — injected so a test can make it instant. */
  sleep(ms: number): Promise<void>;
};

/** apps/os's failure backoff, folded into the debounce window: doubling from the policy's base per
 *  consecutive failure, capped at its ceiling; nothing after a success. */
export function retryBackoffMs(
  state: Pick<AgentView, "consecutiveLlmFailures" | "config">,
): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
}

/** The tree the model reads, rendered from the SANDBOX's `rewriteRules.list()`: one line per row,
 *  `itx.<name> — <description>` (`⇒ <target>` when undescribed), masks and the sandbox's own link
 *  omitted, grouped by the context a row came from when there is more than one. Nothing is
 *  journaled: the list is state, and the model sees it as it stands this turn. */
export function renderCapabilityTree(rows: RewriteRuleListEntry[]): string | null {
  const visible = rows.filter((row) => row.target && row.match !== "itx");
  if (visible.length === 0) return null;
  const line = (row: RewriteRuleListEntry): string =>
    `${row.match} — ${row.description || `⇒ ${row.target}`}`;
  const contexts = [...new Set(visible.map((row) => row.context))];
  const body =
    contexts.length === 1
      ? visible.map(line)
      : contexts.flatMap((context) => [
          `from ${context}:`,
          ...visible.filter((row) => row.context === context).map(line),
        ]);
  return [
    "`itx` IS THIS CONTEXT'S CAPABILITY TREE (`await itx.rewriteRules.list()`) — every name below is one you can spell inside a tag; nothing else resolves:",
    ...body,
  ].join("\n");
}

/** The conversation as the model reads it. An item's images become image parts (a data: URL of the
 *  bytes in `images`, keyed by path — a vision model sees the pixels); any other attachment, or an
 *  image whose bytes are gone, is a line naming it and how a script reads it (apps/os's hint line).
 *  The developer's notes read as system instructions. The capability tree, when given, rides as one
 *  system message after the journaled system prompt — fresh every turn, never in the log. */
export function buildChatMessages(
  items: AgentView["contextItems"],
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

/** How a non-image (or gone) attachment is named to the model. */
function fileHintLine(file: FileAttachment): string {
  return `[Attached file: ${file.filename} (${file.contentType}, ${String(file.size)} bytes) — read it with \`await itx.files.get(${JSON.stringify(file.path)}).bytes()\`]`;
}

/** apps/os's chunk-coalescing window: how much streamed output rides one `llm-response-chunks`
 *  append — ~7 repaints a second, and one commit per window instead of per token. */
const CHUNK_WINDOW_MS = 150;
/** A window that grew past this lands early rather than as one oversized append. */
const CHUNK_WINDOW_MAX_CHARS = 64_000;
/** apps/os's idle watchdog: a stream that carries nothing for this long fails the attempt, so a
 *  stalled provider never wedges a turn until its expiry. */
const STREAM_IDLE_BUDGET_MS = 45_000;

/** apps/os's table, the models this loop names; a conservative floor for the rest. OpenAI's
 *  figures are the operating window (where pricing doubles), not the documented one. */
export function contextWindowTokens(model: string): number {
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
  ...events: StreamEventInput[]
): Promise<void> {
  try {
    await append(...events);
  } catch (error) {
    if (!/idempotency key .* already names a different event/.test(String(error))) throw error;
  }
}

/** Bytes → base64, in chunks (a spread of a large array overflows the call stack). */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type AgentEvent = ConsumedEvent<typeof AgentContract>;
type AgentArgs = ProcessEventArgs<AgentView, AgentEvent>;

/** A settlement as the model reads it next — or null when the script returned nothing: the turn ends. */
export function renderScriptSettlement(
  settlement: Extract<
    AgentEvent,
    { type: "events.iterate.com/capability-host/script-run-settled" }
  >["payload"]["settlement"],
): string | null {
  if (settlement.status === "failed")
    return `Your script failed (${settlement.failureKind}):\n\`\`\`\n${settlement.error}\n\`\`\``;
  if (settlement.result === undefined) return null;
  return `Your script returned:\n\`\`\`json\n${JSON.stringify(settlement.result, null, 2)}\n\`\`\``;
}

export class AgentProcessor extends StreamProcessor<AgentView, AgentEvent> {
  readonly contract = AgentContract;

  constructor(private readonly deps: AgentDeps) {
    super();
  }

  /** The obligations THIS incarnation is running, so a later at-head pass over the same fold does
   *  not start a second attempt; the durable ground is the fold (`openRequest`, `activeScriptExecutions`). */
  readonly #llmRequestsInFlight = new Map<
    number,
    { controller: AbortController; partialText: string }
  >();
  readonly #scriptExecutionsInFlight = new Set<string>();

  reduce({ state, event }: ReduceArgs<AgentView, AgentEvent>): AgentView | undefined {
    switch (event.type) {
      case "events.iterate.com/agent/created":
        return state.path ? undefined : { ...state, path: event.payload.path };

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

      case "events.iterate.com/agents/context-added": {
        const { role, content, actor, llmRequestPolicy, llmRequestOffset } = event.payload;
        const next: AgentView = {
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

      case "events.iterate.com/capability-host/script-run-requested": {
        const { executionId, code, expiresAt } = event.payload;
        if (state.activeScriptExecutions[executionId]) return undefined;
        return {
          ...state,
          activeScriptExecutions: {
            ...state.activeScriptExecutions,
            [executionId]: { code, requestedAtOffset: event.offset, expiresAt },
          },
        };
      }

      case "events.iterate.com/capability-host/script-run-settled": {
        const { [event.payload.executionId]: settled, ...rest } = state.activeScriptExecutions;
        return settled ? { ...state, activeScriptExecutions: rest } : undefined;
      }

      default:
        return undefined;
    }
  }

  processEvent(args: AgentArgs): undefined {
    const { event, state, append, blockProcessorWhile } = args;
    // THE INTERRUPT (apps/os's): cancellation is a property of new input, never a command. The
    // person's words abort whatever this incarnation is streaming, keep what streamed as an
    // assistant item the next turn can see (no llmRequestOffset: a record, never parsed for a
    // script), and settle the request cancelled — blocked, so an eviction can never leave the
    // request open for the next at-head pass to adopt. Their reduce already moved the trigger; the
    // settlement's own delivery re-runs the at-head pass, which then records the next request.
    if (
      event?.type === "events.iterate.com/agents/context-added" &&
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
                  type: "events.iterate.com/agents/context-added",
                  idempotencyKey: this.idempotencyKey(
                    `interrupted/${String(open.requestedAtOffset)}`,
                  ),
                  payload: {
                    role: "assistant",
                    content: `[Response interrupted by the user's next message; partial output follows]\n${partialText}`,
                  },
                } satisfies StreamEventInput,
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
      event?.type === "events.iterate.com/agents/context-added" &&
      event.payload.role === "assistant" &&
      event.payload.llmRequestOffset !== undefined
    ) {
      const { llmRequestOffset } = event.payload;
      const outcome = parseCodemodeResponse(event.payload.content);
      const consequences: StreamEventInput[] = [];
      if (outcome.kind === "malformed" || outcome.kind === "multiple")
        consequences.push({
          type: "events.iterate.com/agents/context-added",
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
          type: "events.iterate.com/capability-host/script-run-requested",
          idempotencyKey: this.idempotencyKey("script-run-requested", event),
          payload: {
            code: outcome.code,
            executionId: `agent-output:${String(event.offset)}`,
            expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
          },
        });
      }
      // The prose — beside a tag or on its own — is the message, appended directly on this context.
      // Where a reply GOES from here is a subscriber's business (events are the interface), never a
      // script the model's sandbox would have to be granted a door for.
      if ((outcome.kind === "script" || outcome.kind === "none") && outcome.prose)
        consequences.push({
          type: "events.iterate.com/agents/web-message-sent",
          idempotencyKey: this.idempotencyKey("codemode-prose", event),
          payload: { message: outcome.prose, llmRequestOffset },
        });
      if (consequences.length > 0) blockProcessorWhile(() => append(...consequences));
    }

    if (event?.type === "events.iterate.com/capability-host/script-run-settled") {
      const rendered = renderScriptSettlement(event.payload.settlement);
      if (rendered)
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: this.idempotencyKey("script-result", event),
            payload: {
              role: "developer",
              content: rendered,
              actor: { type: "script", executionId: event.payload.executionId },
            },
          }),
        );
    }

    this.#atHead(args);
  }

  // ── state-derived consequences, at head, in the background: re-derived by any later delivery ──
  #atHead({ state, delivery, append, runInBackground }: AgentArgs): void {
    if (!delivery.caughtUp || !state.path) return;
    const now = this.deps.now();

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
      // THE DEBOUNCE (apps/os's): wait for more content, plus the failure backoff — one window,
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
      const intent = {
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: this.idempotencyKey(`request/${String(trigger.offset)}`),
        payload: {
          model: llm.model,
          expiresAt: trigger.atMs + llmRequestExpiryMs,
          triggerOffset: trigger.offset,
        },
      };
      runInBackground(async () => {
        if (windowClosesInMs > 0) await this.deps.sleep(windowClosesInMs);
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

    // Open scripts nobody HERE is running: the same, per executionId.
    for (const [executionId, row] of Object.entries(state.activeScriptExecutions)) {
      if (this.#scriptExecutionsInFlight.has(executionId)) continue;
      if (now >= row.expiresAt) {
        runInBackground(() =>
          append({
            type: "events.iterate.com/capability-host/script-run-settled",
            idempotencyKey: this.idempotencyKey(`script-run-settled/${executionId}`),
            payload: {
              executionId,
              settlement: {
                status: "failed",
                error: "the script expired before it ran",
                failureKind: "expired",
              },
            },
          }),
        );
        continue;
      }
      this.#scriptExecutionsInFlight.add(executionId);
      runInBackground(() => this.#runScript(executionId, row.code, append));
    }
  }

  /** The model over the conversation up to the request, STREAMED: each coalescing window of provider
   *  events is one ephemeral `llm-response-chunks` (a feed renders the answer as it is written); ONE
   *  batch then settles the request, lands the assistant's words and reports the cost, so an eviction
   *  between them is impossible. An interruption settles the request itself (processEvent) — an
   *  aborted stream ends here silently, and a success that raced it loses on the settle key. */
  async #runLlmRequest(
    open: NonNullable<AgentView["openRequest"]>,
    state: AgentView,
    append: AgentArgs["append"],
    inFlight: { controller: AbortController; partialText: string },
  ): Promise<void> {
    const startedAt = this.deps.now();
    const { controller } = inFlight;
    // Two clocks fail a stalled stream, never wedge it: the request's own expiry, and apps/os's
    // idle budget since the last provider event.
    const expiry = setTimeout(
      () => controller.abort(new Error("the model did not finish before the request expired")),
      Math.max(1_000, open.expiresAt - startedAt),
    );
    let idle = setTimeout(
      () => controller.abort(new Error("the model stream stalled")),
      STREAM_IDLE_BUDGET_MS,
    );
    try {
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
              base64: base64Of(await this.deps.readFile(file.path)),
            });
          } catch {
            // named by its hint line instead
          }
        }
      const messages = buildChatMessages(items, images, await this.deps.rewriteRules());
      // THE CHUNK WINDOWS (apps/os's coalescing): provider events pile into one buffer; a window
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
              type: "events.iterate.com/agent/llm-response-chunks",
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
        ...alongside: StreamEventInput[]
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
              durationMs: this.deps.now() - startedAt,
              result,
            },
          },
          ...alongside,
        );
      };
      let answer: { text: string; usage?: LlmUsage };
      try {
        answer = await this.deps.stream({
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
            void this.deps.sleep(CHUNK_WINDOW_MS).then(closeWindow);
          },
        });
      } catch (error) {
        // The interrupt path's story — it settled the request itself.
        if (controller.signal.reason instanceof InterruptedError) return;
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
          type: "events.iterate.com/agents/context-added",
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
              } satisfies StreamEventInput,
            ]
          : []),
      );
    } finally {
      clearTimeout(expiry);
      clearTimeout(idle);
      this.#llmRequestsInFlight.delete(open.requestedAtOffset);
    }
  }

  /** The script against this context; what it returned or threw is the settlement. */
  async #runScript(executionId: string, code: string, append: AgentArgs["append"]): Promise<void> {
    try {
      let settlement: Extract<
        AgentEvent,
        { type: "events.iterate.com/capability-host/script-run-settled" }
      >["payload"]["settlement"];
      try {
        // `result` undefined is the turn's end (renderScriptSettlement); JSON drops it on the wire.
        settlement = { status: "succeeded", result: await this.deps.runScript(code) };
      } catch (error) {
        settlement = {
          status: "failed",
          error: String(error instanceof Error ? error.message : error).slice(0, 8_000),
          failureKind: "runtime",
        };
      }
      await append({
        type: "events.iterate.com/capability-host/script-run-settled",
        idempotencyKey: this.idempotencyKey(`script-run-settled/${executionId}`),
        payload: { executionId, settlement },
      });
    } finally {
      this.#scriptExecutionsInFlight.delete(executionId);
    }
  }
}

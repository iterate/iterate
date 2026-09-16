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
import {
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "../stream/processor.ts";
import {
  AgentContract,
  type AgentView,
  type ChatMessage,
  type FileAttachment,
} from "./contract.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

/** What the host injects: the model and the script runner, both reached through `itx` there. */
export type AgentDeps = {
  /** One model call over the conversation so far → the assistant's text. */
  chat(input: { model: string; messages: ChatMessage[] }): Promise<{ text: string }>;
  /** Run `async (itx) => …` against this context; what it returned (JSON), or a throw. */
  runScript(code: string): Promise<unknown>;
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

/** The conversation as the model reads it. An item's images become image parts (a data: URL of the
 *  bytes in `images`, keyed by path — a vision model sees the pixels); any other attachment, or an
 *  image whose bytes are gone, is a line naming it and how a script reads it (apps/os's hint line).
 *  The developer's notes read as system instructions. */
export function buildChatMessages(
  items: AgentView["contextItems"],
  images: Map<string, { contentType: string; base64: string }>,
): ChatMessage[] {
  return items.map((item) => {
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
}

/** How a non-image (or gone) attachment is named to the model. */
function fileHintLine(file: FileAttachment): string {
  return `[Attached file: ${file.filename} (${file.contentType}, ${String(file.size)} bytes) — read it with \`await itx.files.get(${JSON.stringify(file.path)}).bytes()\`]`;
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
  readonly #llmRequestsInFlight = new Set<number>();
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
    // same path — or settle it expired.
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
        this.#llmRequestsInFlight.add(open.requestedAtOffset);
        runInBackground(() => this.#runLlmRequest(open, state, append));
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

  /** The model over the conversation up to the request; ONE batch settles it and lands the
   *  assistant's words, so an eviction between the two is impossible. */
  async #runLlmRequest(
    open: NonNullable<AgentView["openRequest"]>,
    state: AgentView,
    append: AgentArgs["append"],
  ): Promise<void> {
    const startedAt = this.deps.now();
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
      const messages = buildChatMessages(items, images);
      let text: string;
      try {
        text = (await this.deps.chat({ model: open.model, messages })).text;
      } catch (error) {
        await append({
          type: "events.iterate.com/agent/llm-request-settled",
          idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
          payload: {
            requestOffset: open.requestedAtOffset,
            durationMs: this.deps.now() - startedAt,
            result: {
              status: "failed",
              errorMessage: String(error instanceof Error ? error.message : error).slice(0, 4_000),
            },
          },
        });
        return;
      }
      await append(
        {
          type: "events.iterate.com/agent/llm-request-settled",
          idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
          payload: {
            requestOffset: open.requestedAtOffset,
            durationMs: this.deps.now() - startedAt,
            result: { status: "succeeded", text },
          },
        },
        {
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: this.idempotencyKey(`assistant/${String(open.requestedAtOffset)}`),
          payload: { role: "assistant", content: text, llmRequestOffset: open.requestedAtOffset },
        },
      );
    } finally {
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

import { z } from "zod";
import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import {
  AGENT_LLM_REQUEST_BACKSTOP_MS,
  AgentProcessorContract,
  DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
  DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
  DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
  type AgentFileAttachment,
} from "./agent-processor-contract.ts";

type AgentState = z.infer<typeof AgentProcessorContract.stateSchema>;
type AgentConsumedEvent = ReturnType<typeof AgentProcessorContract.parseEvent>;

/**
 * Host-provided deps beyond the stream plumbing.
 *
 * - `ai` is the Workers AI binding (`env.AI`) used for every LLM turn.
 * - `writeWorkspaceFile` writes one file into THIS agent's own workspace (the
 *   same checkout `itx.workspace` resolves to) so oversized script results can
 *   spill to a file the model pages through with plain JavaScript. Optional:
 *   without it (bare test hosts), oversized results fall back to inline
 *   truncation.
 * - `readStreamEvents` rebuilds the chat request by reducing committed history
 *   up to the llmRequestId offset. Production pages the agent's stream; tests
 *   pass the in-memory event list.
 */
type AgentProcessorDeps = {
  ai?: { run(model: string, body: unknown): Promise<unknown> };
  readStreamEvents?: () => Promise<StreamEvent[]>;
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<void>;
  /** Injected clock (expiry stamps + backstop deadline); defaults to Date.now. */
  now?: () => number;
};

export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #scheduledRequestsWithActiveTimers = new Set<string>();

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * llmRequestIds with an execution alive in THIS incarnation. End-of-batch
   * reconciliation compares the fold's open obligations against this set.
   */
  readonly #liveLlmExecutions = new Set<number>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["reduce"]>[0]) {
    return reduceAgentEvent({ event, state });
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<AgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/agent/config-updated": {
        if (event.payload.systemPrompt === undefined) return;
        const { systemPrompt } = event.payload;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/system-prompt-updated",
            idempotencyKey: `agent/system-prompt-updated@${event.offset}`,
            payload: { systemPrompt },
          }),
        );
        return;
      }
      case "events.iterate.com/agents/user-message-received":
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-message@${event.offset}`,
            payload: {
              content: event.payload.content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          }),
        );
        return;
      case "events.iterate.com/agents/web-message-sent": {
        // Files the agent attached to its own message ride the reflection too,
        // so the model SEES what it sent (vision) on later turns.
        const files = event.payload.files;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-web-response@${event.offset}`,
            payload: {
              content: `The assistant sent this visible web-chat message: ${event.payload.message}`,
              ...(files === undefined || files.length === 0 ? {} : { files }),
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
        return;
      }
      case "events.iterate.com/agent/input-added": {
        // Scheduling the next LLM request is derived from reduced state at the
        // end of the batch (see #settleLlmRequestScheduling); the only
        // per-event side effect is interrupting a request already underway.
        if (event.payload.llmRequestPolicy.behaviour !== "interrupt-current-request") return;
        const interrupted = previousState.currentRequest;
        if (interrupted === null) return;
        blockProcessorWhile(() => append(cancelEventForCurrentRequest(interrupted)));
        return;
      }
      case "events.iterate.com/agent/llm-request-scheduled":
        // The debounce timer is a droppable ATTEMPT: the scheduled event is
        // the durable evidence, and #settleLlmRequestScheduling re-derives a
        // lost timer from the fold. Losing this closure costs latency, never
        // the request.
        this.#scheduledRequestsWithActiveTimers.add(event.payload.requestId);
        runInBackground(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, event.payload.debounceMs));
          try {
            await append(
              this.#buildLlmRequestRequested({
                model: event.payload.model,
                requestId: event.payload.requestId,
                scheduledOffset: event.offset,
              }),
            );
          } finally {
            this.#scheduledRequestsWithActiveTimers.delete(event.payload.requestId);
          }
        });
        return;
      // LLM starts at end-of-batch reconciliation (#reconcileLlmRequests), not
      // here — so a mid-refold never dials env.AI for a long-settled request.
      case "events.iterate.com/agent/llm-request-requested":
        return;
      case "events.iterate.com/agent/output-added":
        blockProcessorWhile(async () => {
          const code = extractAsyncJsSnippet(event.payload.content);
          if (code === null) return;
          await append({
            type: "events.iterate.com/capability-host/script-execution-requested",
            idempotencyKey: `itx/script-execution-requested@${event.offset}`,
            payload: {
              code,
              executionId: `${AGENT_SCRIPT_EXECUTION_ID_PREFIX}${event.offset}`,
              expiresAt: this.#now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
            },
          });
        });
        return;
      case "events.iterate.com/capability-host/script-execution-completed": {
        // Rendering may spill an oversized result into the agent's workspace
        // first (a durable write that can wait on the checkout's first-use
        // clone), so the whole render-then-append runs inside the blocking
        // section — the input must not land before the file it references.
        blockProcessorWhile(async () => {
          const content = await scriptResultAgentInput(event, this.deps.writeWorkspaceFile);
          if (content === null) return;
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-script-result@${event.offset}`,
            payload: {
              content,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          });
        });
        return;
      }
      // A failed request must never brick the stream: the error becomes a
      // model-visible input, exactly like a thrown script. Below the
      // consecutive-failure cap the input triggers a retry so the model can
      // react (fix its request, tell the user what happened); at the cap it
      // sits in context untriggered so a persistent provider failure (bad key,
      // outage) cannot retry-loop — the next user message resumes normally.
      case "events.iterate.com/agent/llm-request-completed": {
        const result = event.payload.result;
        if (result.status !== "failure") return;
        if (
          previousState.currentRequest?.phase !== "requested" ||
          previousState.currentRequest.llmRequestId !== event.payload.llmRequestId
        ) {
          // Stale completion (e.g. the request was already cancelled) — the
          // reducer ignored it, so don't render an error input for it either.
          return;
        }
        const retry = state.consecutiveLlmFailures < MAX_CONSECUTIVE_LLM_FAILURES;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/render-llm-failure@${event.offset}`,
            payload: {
              content:
                `Your LLM request failed:\n\`\`\`\n${result.error.message}\n\`\`\`` +
                (retry
                  ? ""
                  : `\nConsecutive failure ${state.consecutiveLlmFailures} — automatic retries stopped; this stays in your context for the next turn.`),
              llmRequestPolicy: {
                behaviour: retry ? "after-current-request" : "dont-trigger-request",
              },
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    await this.#reconcileLlmRequests(args);
    await this.#settleLlmRequestScheduling(args);
  }

  /**
   * End-of-batch reconciliation of open LLM obligations against this
   * incarnation's live executions (at-head only — mid-refold never dials AI
   * or journals false failures):
   *
   * - `requested`, not live, not expired → START the attempt
   * - `requested` but expired → settle as expired failure
   * - `started`, not live → orphaned failure (never re-drive)
   */
  async #reconcileLlmRequests(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    if (args.checkpointOffset < args.streamMaxOffset) return;
    const now = this.#now();
    const settle: { llmRequestId: number; message: string }[] = [];
    for (const [id, request] of Object.entries(args.state.llmRequests)) {
      const llmRequestId = Number(id);
      if (this.#liveLlmExecutions.has(llmRequestId)) continue;
      if (request.status === "requested" && now < request.expiresAt) {
        this.#liveLlmExecutions.add(llmRequestId);
        args.runInBackground(async () => {
          try {
            await this.#executeLlmRequest({ llmRequestId, model: request.model });
          } finally {
            this.#liveLlmExecutions.delete(llmRequestId);
          }
        });
        continue;
      }
      settle.push({
        llmRequestId,
        message:
          request.status === "started"
            ? "LLM request orphaned: the incarnation executing it went away before completing (eviction or wedged call). Failed by the reconciler; the agent's next trigger reschedules."
            : "LLM request expired before any attempt started (the host was down past the request's expiry). Failed by the reconciler; the agent's next trigger reschedules.",
      });
    }
    if (settle.length === 0) return;
    args.blockProcessorWhile(async () => {
      for (const { llmRequestId, message } of settle) {
        console.error("[agent] settling undriven llm request", { llmRequestId, message });
        await args.append({
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: `agent/llm-request-completed@${llmRequestId}`,
          payload: {
            durationMs: 0,
            llmRequestId,
            result: { status: "failure", error: { message } },
          },
        });
      }
    });
  }

  /**
   * The LLM-request scheduling decision, derived from reduced state once per
   * batch after the whole fold — never per event, where appends made earlier
   * in the same batch are invisible. "A trigger is pending and no request is
   * current" means exactly one llm-request-scheduled for the current request
   * generation; the generation-keyed idempotency makes every re-derivation
   * (many inputs in one batch, chunked delivery, crash replay) collapse into
   * the same stream event.
   */
  async #settleLlmRequestScheduling(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    // At-head gate: scheduling decisions and the backstop must never fire
    // from a mid-catch-up fold — a long-settled request transiently looks
    // `requested` mid-refold, and backstopping it would journal a false failure.
    if (args.checkpointOffset < args.streamMaxOffset) return;
    const { state } = args;
    if (state.currentRequest === null) {
      if (state.pendingTriggerOffset === null) return;
      if (
        state.pendingTriggerSource === "agent-loop" &&
        state.autonomousTurnCount >= DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS
      ) {
        await args.append({
          type: "events.iterate.com/agent/loop-stopped",
          idempotencyKey: `agent/autonomous-turn-limit:${state.pendingTriggerOffset}`,
          payload: {
            maxAutonomousTurns: DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS,
            reason: `Agent circuit breaker stopped after ${DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS} consecutive autonomous turns.`,
            triggerOffset: state.pendingTriggerOffset,
          },
        });
        return;
      }
      await args.append({
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: `agent/llm-request-scheduled@generation:${state.requestGeneration}`,
        payload: {
          debounceMs: DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS,
          model: state.llmConfig.model,
          requestId: `llm-request:gen-${state.requestGeneration}`,
        },
      });
      return;
    }
    if (state.currentRequest.phase === "requested") {
      // Outer backstop if reconciliation never settled (should be rare with
      // a single processor that both schedules and runs LLM turns).
      const requestedAt = state.currentRequest.requestedAt;
      if (requestedAt === undefined) return;
      if (this.#now() - requestedAt < AGENT_LLM_REQUEST_BACKSTOP_MS) return;
      const llmRequestId = state.currentRequest.llmRequestId;
      await args.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/backstop-completed@${llmRequestId}`,
        payload: {
          durationMs: this.#now() - requestedAt,
          llmRequestId,
          result: {
            status: "failure",
            error: {
              message: `No LLM attempt settled this request within ${AGENT_LLM_REQUEST_BACKSTOP_MS / 60_000} minutes; failed by the agent's backstop reconciler.`,
            },
          },
        },
      });
      return;
    }
    if (this.#scheduledRequestsWithActiveTimers.has(state.currentRequest.requestId)) return;
    // No active timer for this scheduled request: the DO restarted and lost the
    // debounce. Fire llm-request-requested immediately. The idempotency key
    // makes this safe if the timer also fires concurrently.
    await args.append(
      this.#buildLlmRequestRequested({
        model: state.llmConfig.model,
        requestId: state.currentRequest.requestId,
        scheduledOffset: state.currentRequest.scheduledOffset,
      }),
    );
  }

  /** The one construction of llm-request-requested (debounce and recovery
   * paths), so the expiry stamp and idempotency key can never drift apart. */
  #buildLlmRequestRequested(input: {
    model: string;
    requestId: string;
    scheduledOffset: number;
  }) {
    return {
      type: "events.iterate.com/agent/llm-request-requested" as const,
      idempotencyKey: `agent/llm-request-requested@${input.scheduledOffset}`,
      payload: {
        model: input.model,
        requestId: input.requestId,
        expiresAt: this.#now() + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
      },
    };
  }

  async #executeLlmRequest(input: { llmRequestId: number; model: string }): Promise<void> {
    const { llmRequestId, model } = input;
    const startedAt = this.#now();
    // Started-evidence outside the inner try: if this append fails the model
    // was never dialed, so no completion may be appended — the obligation
    // stays `requested` and a later reconciliation retries the attempt.
    await this.stream.append({
      type: "events.iterate.com/agent/llm-request-started",
      idempotencyKey: `agent/llm-request-started@${llmRequestId}`,
      payload: { llmRequestId, model },
    });

    try {
      if (this.deps.ai === undefined) {
        throw new Error("Agent processor has no AI binding configured.");
      }
      const events =
        this.deps.readStreamEvents !== undefined
          ? await this.deps.readStreamEvents()
          : await this.stream.getEvents({ limit: 5_000 });
      const body = buildAgentLlmRequestBody({ events, llmRequestId });
      // Workers AI chat bodies are text-only here: file attachments flatten
      // to hint lines telling the agent how to fetch/convert the bytes.
      const messages = body.messages.map((message) => ({
        role: message.role,
        content: flattenMessageToText(message),
      }));
      const raw = await this.deps.ai.run(model, { messages, stream: true });
      const completion =
        raw instanceof ReadableStream
          ? await this.#consumeStream({ body: raw, llmRequestId })
          : {
              text: extractAssistantText(raw),
              rawResponse: jsonCompatible(raw),
              usage: extractUsage(raw),
            };

      const durationMs = Date.now() - startedAt;
      const result = {
        status: "success" as const,
        rawResponse: completion.rawResponse,
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      };

      if (await this.#isRequestStillCurrent({ llmRequestId })) {
        await this.stream.append({
          type: "events.iterate.com/agent/output-added",
          idempotencyKey: `agent/output-added@${llmRequestId}`,
          payload: { content: completion.text, llmRequestId },
        });
      }

      await this.stream.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/llm-request-completed@${llmRequestId}`,
        payload: { durationMs, llmRequestId, result },
      });
    } catch (error) {
      await this.stream.append({
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `agent/llm-request-completed@${llmRequestId}`,
        payload: {
          durationMs: Date.now() - startedAt,
          llmRequestId,
          result: {
            status: "failure",
            error: { message: stringifyError(error) },
          },
        },
      });
    }
  }

  async #consumeStream(input: {
    body: ReadableStream;
    llmRequestId: number;
  }): Promise<{ rawResponse: unknown; text: string; usage?: unknown }> {
    const reader = input.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sequence = 0;
    let text = "";
    let usage: unknown;

    const handleChunk = async (chunk: unknown) => {
      text += extractChunkText(chunk);
      usage = extractUsage(chunk) ?? usage;
      await this.stream.append({
        type: "events.iterate.com/agent/llm-response-chunk",
        idempotencyKey: `agent/llm-response-chunk@${input.llmRequestId}:${sequence}`,
        payload: {
          chunk: jsonCompatible(chunk),
          llmRequestId: input.llmRequestId,
          sequence,
        },
      });
      sequence += 1;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const chunk = parseSseFrame(frame);
        if (chunk !== undefined) await handleChunk(chunk);
      }
    }
    buffered += decoder.decode();
    const finalChunk = parseSseFrame(buffered);
    if (finalChunk !== undefined) await handleChunk(finalChunk);

    return {
      rawResponse: {
        streamed: true,
        chunkCount: sequence,
        response: text,
        ...(usage === undefined ? {} : { usage }),
      },
      text,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  async #isRequestStillCurrent(input: { llmRequestId: number }) {
    const events =
      this.deps.readStreamEvents !== undefined
        ? await this.deps.readStreamEvents()
        : await this.stream.getEvents({ limit: 5_000 });
    const state = reduceAgentEvents(events);
    return (
      state.currentRequest?.phase === "requested" &&
      state.currentRequest.llmRequestId === input.llmRequestId
    );
  }
}

export function reduceAgentEvents(events: readonly StreamEvent[]): AgentState {
  let state = AgentProcessorContract.stateSchema.parse({});
  for (const event of events) {
    try {
      state = reduceAgentEvent({
        event: AgentProcessorContract.parseEvent(event) as AgentConsumedEvent,
        state,
      });
    } catch {
      continue;
    }
  }
  return state;
}

/** One agent-history message as the model receives it. */
export type AgentChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  files?: AgentFileAttachment[];
};

function buildLlmChatRequest(state: AgentState): { messages: AgentChatMessage[] } {
  return {
    messages: [{ role: "system" as const, content: state.systemPrompt }, ...state.history],
  };
}

/**
 * The model-visible text for a file the current model cannot ingest natively:
 * never fail the turn — tell the agent where the bytes live and how to read
 * or convert them, and let it act (fetch via itx.files, convert via
 * itx.ai.toMarkdown) on its next script.
 */
export function renderFileHintLine(file: AgentFileAttachment): string {
  return (
    `[Attached file: ${file.filename} (${file.contentType}, ${file.size} bytes) — ` +
    `bytes: await itx.files.get(${JSON.stringify(file.path)}).bytes(); ` +
    `convert: itx.ai.toMarkdown; public url: ${file.url}]`
  );
}

/**
 * Flattens one history message to plain text: content plus a hint line per
 * attachment. Providers without native file support (or for non-image files)
 * render attachments this way.
 */
export function flattenMessageToText(message: AgentChatMessage): string {
  const files = message.files ?? [];
  if (files.length === 0) return message.content;
  return [message.content, ...files.map(renderFileHintLine)].join("\n");
}

export function buildAgentLlmRequestBody(input: {
  events: readonly StreamEvent[];
  llmRequestId: number;
}) {
  return buildLlmChatRequest(
    reduceAgentEvents(input.events.filter((event) => event.offset <= input.llmRequestId)),
  );
}

function reduceAgentEvent(input: { event: AgentConsumedEvent; state: AgentState }): AgentState {
  const { event, state } = input;
  switch (event.type) {
    case "events.iterate.com/agent/config-updated":
      return state;
    case "events.iterate.com/agent/system-prompt-updated":
      return { ...state, systemPrompt: event.payload.systemPrompt };
    case "events.iterate.com/agent/input-added": {
      const triggerSource = agentInputTriggerSource(event);
      const files = event.payload.files;
      return {
        ...state,
        history: [
          ...state.history,
          {
            role: "user",
            content: event.payload.content,
            ...(files === undefined || files.length === 0 ? {} : { files }),
          },
        ],
        pendingTriggerOffset: triggerSource === null ? state.pendingTriggerOffset : event.offset,
        pendingTriggerSource: triggerSource === null ? state.pendingTriggerSource : triggerSource,
        autonomousTurnCount: triggerSource === "user" ? 0 : state.autonomousTurnCount,
      };
    }
    case "events.iterate.com/agent/output-added":
      return {
        ...state,
        history: [...state.history, { role: "assistant", content: event.payload.content }],
      };
    case "events.iterate.com/agent/llm-provider-selected":
      if (event.payload.ifUnset && state.llmConfigConfigured) return state;
      return {
        ...state,
        llmConfig: { model: event.payload.model },
        llmConfigConfigured: true,
      };
    case "events.iterate.com/agent/llm-request-scheduled":
      return {
        ...state,
        currentRequest: {
          phase: "scheduled",
          requestId: event.payload.requestId,
          scheduledOffset: event.offset,
        },
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
        autonomousTurnCount:
          state.pendingTriggerSource === "agent-loop" ? state.autonomousTurnCount + 1 : 0,
      };
    case "events.iterate.com/agent/llm-request-requested": {
      const key = String(event.offset);
      const expiresAt =
        event.payload.expiresAt ??
        Date.parse(event.createdAt) + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS;
      const withLifecycle: AgentState = {
        ...state,
        llmRequests: {
          ...state.llmRequests,
          [key]: {
            status: "requested" as const,
            model: event.payload.model,
            expiresAt,
          },
        },
      };
      if (
        state.currentRequest?.phase !== "scheduled" ||
        state.currentRequest.requestId !== event.payload.requestId
      ) {
        return withLifecycle;
      }
      return {
        ...withLifecycle,
        currentRequest: {
          phase: "requested",
          llmRequestId: event.offset,
          requestedAt: Date.parse(event.createdAt),
        },
        pendingTriggerOffset: null,
      };
    }
    case "events.iterate.com/agent/llm-request-started": {
      const key = String(event.payload.llmRequestId);
      const existing = state.llmRequests[key];
      if (existing === undefined) return state;
      return {
        ...state,
        llmRequests: {
          ...state.llmRequests,
          [key]: { ...existing, status: "started" as const },
        },
      };
    }
    case "events.iterate.com/agent/llm-request-completed": {
      const llmRequests = { ...state.llmRequests };
      delete llmRequests[String(event.payload.llmRequestId)];
      const next: AgentState = { ...state, llmRequests };
      if (
        state.currentRequest?.phase !== "requested" ||
        state.currentRequest.llmRequestId !== event.payload.llmRequestId
      ) {
        return next;
      }
      return {
        ...next,
        consecutiveLlmFailures:
          event.payload.result.status === "failure" ? state.consecutiveLlmFailures + 1 : 0,
        currentRequest: null,
        requestGeneration: state.requestGeneration + 1,
      };
    }
    case "events.iterate.com/agent/llm-request-cancelled":
      if (
        event.payload.phase === "scheduled" &&
        state.currentRequest?.phase === "scheduled" &&
        state.currentRequest.requestId === event.payload.requestId
      ) {
        return { ...state, currentRequest: null, requestGeneration: state.requestGeneration + 1 };
      }
      if (
        event.payload.phase === "requested" &&
        state.currentRequest?.phase === "requested" &&
        state.currentRequest.llmRequestId === event.payload.llmRequestId
      ) {
        const llmRequests = { ...state.llmRequests };
        delete llmRequests[String(event.payload.llmRequestId)];
        return {
          ...state,
          currentRequest: null,
          requestGeneration: state.requestGeneration + 1,
          llmRequests,
        };
      }
      return state;
    case "events.iterate.com/agent/loop-stopped":
      return {
        ...state,
        pendingTriggerOffset: null,
        pendingTriggerSource: null,
      };
    case "events.iterate.com/capability-host/script-execution-requested":
      return {
        ...state,
        inProgressScriptExecutions: [
          ...state.inProgressScriptExecutions.filter(
            (script) => script.executionId !== event.payload.executionId,
          ),
          {
            code: event.payload.code,
            executionId: event.payload.executionId,
            requestedOffset: event.offset,
            startedAt: event.createdAt,
          },
        ],
      };
    case "events.iterate.com/capability-host/script-execution-completed":
      return {
        ...state,
        inProgressScriptExecutions: state.inProgressScriptExecutions.filter(
          (script) => script.executionId !== event.payload.executionId,
        ),
        scriptExecutionsCompleted: [...state.scriptExecutionsCompleted, event.payload.executionId],
      };
    default:
      return state;
  }
}

function agentInputTriggerSource(
  event: Extract<AgentConsumedEvent, { type: "events.iterate.com/agent/input-added" }>,
): "user" | "agent-loop" | null {
  if (event.payload.llmRequestPolicy.behaviour === "dont-trigger-request") return null;
  // Inputs the loop generates for itself — script results, LLM-failure
  // retries — must count against the autonomous turn limit, not reset it.
  const agentLoopKeyPrefixes = ["agent/render-script-result@", "agent/render-llm-failure@"];
  return agentLoopKeyPrefixes.some((prefix) => event.idempotencyKey?.startsWith(prefix))
    ? "agent-loop"
    : "user";
}

function cancelEventForCurrentRequest(request: NonNullable<AgentState["currentRequest"]>) {
  if (request.phase === "scheduled") {
    return {
      type: "events.iterate.com/agent/llm-request-cancelled" as const,
      idempotencyKey: `agent/llm-request-cancelled@scheduled:${request.scheduledOffset}`,
      payload: {
        phase: "scheduled" as const,
        reason: "interrupted-by-user-input" as const,
        requestId: request.requestId,
      },
    };
  }

  return {
    type: "events.iterate.com/agent/llm-request-cancelled" as const,
    idempotencyKey: `agent/llm-request-cancelled@requested:${request.llmRequestId}`,
    payload: {
      phase: "requested" as const,
      reason: "interrupted-by-user-input" as const,
      llmRequestId: request.llmRequestId,
    },
  };
}

const AGENT_SCRIPT_EXECUTION_ID_PREFIX = "agent-output:";

/**
 * Failed-request error inputs stop auto-retrying once this many failures land
 * in a row (counter resets on any success). Two automatic retries, then wait
 * for the user.
 */
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions this agent did not request stay invisible (other scripts —
//   e.g. Slack bang commands — journal on the same stream);
// - a script that returned undefined and did not throw produces nothing.
//   Returning no value is how an agent ends its turn.
async function scriptResultAgentInput(
  event: Extract<
    AgentConsumedEvent,
    { type: "events.iterate.com/capability-host/script-execution-completed" }
  >,
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"],
): Promise<string | null> {
  const payload = event.payload;
  if (!payload.executionId.startsWith(AGENT_SCRIPT_EXECUTION_ID_PREFIX)) return null;
  if (payload.error !== undefined) {
    return `Your script threw:\n\`\`\`\n${truncateScriptResult(payload.error)}\n\`\`\``;
  }
  if (payload.result === undefined) return null;
  const text = stringifyScriptResult(payload.result);
  if (text.length > SCRIPT_RESULT_HISTORY_LIMIT && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId: payload.executionId,
        text,
        writeWorkspaceFile,
      });
      return [
        "Your script returned:",
        "```json",
        text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT),
        "```",
        spillNotice({ path: spilledPath, totalChars: text.length }),
      ].join("\n");
    } catch (error) {
      // Spilling is best effort: a workspace that cannot clone or write must
      // not lose the result entirely — fall through to inline truncation.
      console.error("[agent] failed to spill oversized script result to workspace", {
        error,
        executionId: payload.executionId,
      });
    }
  }
  return `Your script returned:\n\`\`\`json\n${truncateScriptResult(text)}\n\`\`\``;
}

function stringifyScriptResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

const SCRIPT_RESULT_HISTORY_LIMIT = 30_000;

function truncateScriptResult(text: string): string {
  if (text.length <= SCRIPT_RESULT_HISTORY_LIMIT) return text;
  return `${text.slice(0, SCRIPT_RESULT_HISTORY_LIMIT)}\n… truncated (${text.length} chars total — return less: slice arrays, pick fields)`;
}

/**
 * Where oversized script results land inside the agent's workspace checkout:
 * scratch files for the model to page through with itx.workspace, never meant
 * to be committed. One file per execution, so replays overwrite idempotently.
 * Size is no concern — workspace files past the inline threshold are stored
 * in R2 transparently.
 */
const SCRIPT_RESULT_SPILL_DIR = "/script-results";

/** Writes the full result text into the agent's workspace; returns its path. */
async function spillScriptResult(input: {
  executionId: string;
  text: string;
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  // The agent's documented publish flow is `git.add({ filepath: "." })` —
  // without this nested ignore every spill would ride along into workspace
  // commits (isomorphic-git's add respects .gitignore).
  await input.writeWorkspaceFile({ content: "*\n", path: `${SCRIPT_RESULT_SPILL_DIR}/.gitignore` });
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
  await input.writeWorkspaceFile({ content: input.text, path });
  return path;
}

/**
 * The model-facing text after a truncated preview: where the full result
 * lives and a concrete next-script recipe for paging it, so the model reads
 * the file with plain JavaScript instead of re-running the expensive fetch.
 */
function spillNotice(input: { path: string; totalChars: number }): string {
  return [
    `…truncated: showing the first ${SCRIPT_RESULT_HISTORY_LIMIT.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain JavaScript in your next script, e.g.:`,
    "```js",
    "async (itx) => {",
    `  const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(input.path)}));`,
    "  return Object.keys(data); // then slice/filter/regex to return only what you need",
    "}",
    "```",
  ].join("\n");
}

function extractAsyncJsSnippet(content: string): string | null {
  // Fences count only at line starts: scripts legitimately carry ``` inside
  // string literals (chat messages formatted as markdown), and in valid JS
  // those always sit mid-line — a raw newline cannot appear in a string
  // literal, and an unescaped ``` would terminate a template literal. A fence
  // match anywhere used to cut the script at the first embedded ``` and
  // execute an unparseable prefix (unclosed string literal).
  const fenced = content.match(
    /^[ \t]*```(?:js|javascript|ts|typescript)?[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/im,
  );
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}

function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data === "" || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function extractAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AI response did not contain assistant text.");
  }
  if ("response" in raw && typeof raw.response === "string") return raw.response;

  const choices = (raw as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as
      | { message?: { content?: unknown }; delta?: { content?: unknown } }
      | undefined;
    const content = first?.message?.content ?? first?.delta?.content;
    if (typeof content === "string") return content;
  }

  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("");
  }

  throw new Error("AI response did not contain assistant text.");
}

function extractChunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object" || chunk === null) return "";
  if ("response" in chunk && typeof chunk.response === "string") return chunk.response;

  const choices = (chunk as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { delta?: { content?: unknown } } | undefined;
    if (typeof first?.delta?.content === "string") return first.delta.content;
  }

  const delta = (chunk as { delta?: { text?: unknown } }).delta;
  return typeof delta?.text === "string" ? delta.text : "";
}

function extractUsage(raw: unknown): unknown | undefined {
  return typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined;
}

function jsonCompatible(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

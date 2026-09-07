// THE CODEMODE INTERPRETER, hosted: the project-space derivation processor
// that owns parsing assistant output — both halves of it:
//
//   durable   agents/context-added (assistant) → script-run-requested + the
//             prose as web-message-sent + the status as summary-updated (or
//             corrective feedback), each stamped with `source: { offset }`
//             pointing at the raw assistant event;
//             capability-host/script-run-settled → the rendered result as
//             developer context (the agent's next input);
//   live      ephemeral agent/llm-response-chunks → ephemeral
//             render/message-delta + render/script-delta, so the feed can
//             stream prose as a message and script text as a script while
//             the model is still talking — no renderer ever parses the format.
//
// This logic previously lived in worker.ts's processEvent switch (the
// project-worker push lane), which is observation-grade: a failed delivery is
// skipped, not retried, and ephemeral events never reach it at all. Hosting
// it as a stream-processor facet upgrades interpretation to at-least-once
// delivery with keepalive recovery AND makes the live lane possible —
// ephemeral events are only delivered to a processor whose `consumes` names
// their type.
//
// Idempotency keys deliberately mirror the platform codemode component's raw
// `agent/...` keys (NOT this processor's slug namespace): if the platform's
// parser handled a turn during the birth race — or the old worker.ts lane
// already interpreted it before a config deploy switched to this facet —
// replays dedupe against each other instead of double-executing scripts.
// The collision is the point.
import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  RENDER_MESSAGE_DELTA,
  RENDER_SCRIPT_DELTA,
  renderEventDefinitions,
  isIdempotencyConflict,
} from "iterate/processors";
import type { ProcessorState, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { StreamProcessorFacet, type ProcessorHostDeps } from "iterate/sdk";
import { parseCodemodePartial, parseCodemodeResponse } from "./codemode-format.ts";

/** Assistant output events stamped by the platform's LLM component carry the
 * agent contract's slug. */
const AGENT_PROCESSOR_SLUG = "agent";
const SCRIPT_EXPIRY_MS = 10 * 60_000;
const RESULT_HISTORY_LIMIT = 30_000;
/** Inline budget once the full copy is spilled — the inline copy is a map of
 * the data, not the data. */
const RESULT_SPILL_PREVIEW_CHARS = 10_000;
/** Open script requests remembered for duration rendering. Old entries fall
 * off deterministically; a missing entry just renders without a duration. */
const SCRIPT_REQUEST_HISTORY = 32;

// Platform event types this processor consumes and/or emits. A config-repo
// template cannot import the OS processor contracts (they deliberately stay
// in apps/os), so the foreign types are declared locally below with
// permissive payload schemas — the platform's own contracts remain the
// authority on their real shapes.
const AGENT_CONFIGURED = "events.iterate.com/agent/configured";
const AGENT_CONTEXT_ADDED = "events.iterate.com/agents/context-added";
const AGENT_LLM_RESPONSE_CHUNKS = "events.iterate.com/agent/llm-response-chunks";
const AGENT_SUMMARY_UPDATED = "events.iterate.com/agent/summary-updated";
const AGENT_WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";
const SCRIPT_RUN_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_RUN_SETTLED = "events.iterate.com/capability-host/script-run-settled";

export const CodemodeInterpreterContract = defineProcessorContract({
  slug: "codemode-interpreter",
  version: "0.1.0",
  description:
    "Parses codemode-tag assistant output into its consequences (script runs, chat messages, live labels) and ephemeral render deltas. Renderers never parse the format.",
  stateSchema: z.object({
    /** The agent's platform response parsing flag. Platform births agents
     * with default parsing ON; this interpreter acts only after the template
     * worker's conversion batch turns it off. Tracked by reducing
     * agent/configured events — no per-turn RPC snapshot. */
    interpretResponses: z.boolean().default(true),
    /** Recently requested agent-output script runs, for rendering execution
     * durations from journaled createdAt (deterministic across replays). */
    scriptRequests: z
      .array(z.object({ executionId: z.string(), requestedAt: z.string() }))
      .default([]),
  }),
  events: {
    [AGENT_CONFIGURED]: {
      description: "Platform agent config patch; consumed for the interpretResponses flag.",
      payloadSchema: z.looseObject({}),
    },
    [AGENT_CONTEXT_ADDED]: {
      description:
        "Platform context item. Consumed for assistant output to interpret; emitted for corrective feedback and rendered script results.",
      payloadSchema: z.looseObject({}),
    },
    [AGENT_LLM_RESPONSE_CHUNKS]: {
      description:
        "The platform's ephemeral token-stream lane. Marked ephemeral here too: the catalogue decides which types are live-only, and naming it in consumes is the delivery opt-in.",
      payloadSchema: z.looseObject({}),
      ephemeral: true,
    },
    [AGENT_SUMMARY_UPDATED]: {
      description: "Platform live activity label; emitted from the tag's status attribute.",
      payloadSchema: z.looseObject({}),
    },
    [AGENT_WEB_MESSAGE_SENT]: {
      description:
        "THE assistant-message fact (platform vocabulary). Emitted for the prose outside the tag, stamped with source.offset provenance to the raw assistant event.",
      payloadSchema: z.looseObject({}),
    },
    [SCRIPT_RUN_REQUESTED]: {
      description:
        "Platform script execution request. Emitted for the tag body; consumed to remember requestedAt for duration rendering.",
      payloadSchema: z.looseObject({}),
    },
    [SCRIPT_RUN_SETTLED]: {
      description: "Platform script settlement; consumed to render the result back as context.",
      payloadSchema: z.looseObject({}),
    },
    ...renderEventDefinitions,
  },
  consumes: [
    AGENT_CONFIGURED,
    AGENT_CONTEXT_ADDED,
    AGENT_LLM_RESPONSE_CHUNKS,
    SCRIPT_RUN_REQUESTED,
    SCRIPT_RUN_SETTLED,
  ],
  emits: [
    AGENT_CONTEXT_ADDED,
    AGENT_SUMMARY_UPDATED,
    AGENT_WEB_MESSAGE_SENT,
    SCRIPT_RUN_REQUESTED,
    RENDER_MESSAGE_DELTA,
    RENDER_SCRIPT_DELTA,
  ],
});
export type CodemodeInterpreterContract = typeof CodemodeInterpreterContract;
export type CodemodeInterpreterState = ProcessorState<CodemodeInterpreterContract>;

/** What the interpreter needs from its host beyond the platform deps: a
 * workspace write for spilling oversized script results. Injected so the
 * processor stays testable in plain node with a recording fake. */
export type CodemodeInterpreterHostDeps = {
  writeWorkspaceFile: (workspacePath: string, filePath: string, content: string) => Promise<void>;
};

/** The in-memory live-window accumulator for one streaming LLM request.
 * Incarnation-local and purely cosmetic: an eviction mid-stream loses the
 * earlier chunks, poisons the accumulator, and that turn just skips the
 * pretty live view — the durable facts at settlement are unaffected. */
type LiveAccumulator = {
  text: string;
  nextSequence: number;
  poisoned: boolean;
  lastEmitted: { prose: string; code: string; status: string };
};

export class CodemodeInterpreterProcessor extends StreamProcessor<CodemodeInterpreterContract> {
  readonly contract = CodemodeInterpreterContract;
  readonly #hostDeps: CodemodeInterpreterHostDeps;
  readonly #live = new Map<number, LiveAccumulator>();

  constructor(
    deps: ConstructorParameters<typeof StreamProcessor>[0],
    hostDeps: CodemodeInterpreterHostDeps,
  ) {
    super(deps);
    this.#hostDeps = hostDeps;
  }

  protected override reduce({ event, state }: ReduceArgs<CodemodeInterpreterContract>) {
    switch (event.type) {
      case AGENT_CONFIGURED: {
        const config = readRecord(event.payload, "config");
        if (typeof config?.interpretResponses !== "boolean") return state;
        return { ...state, interpretResponses: config.interpretResponses };
      }
      case SCRIPT_RUN_REQUESTED: {
        const executionId = readString(event.payload, "executionId");
        if (executionId === undefined || !executionId.startsWith("agent-output:")) return state;
        const scriptRequests = [
          ...state.scriptRequests.filter((entry) => entry.executionId !== executionId),
          { executionId, requestedAt: event.createdAt },
        ].slice(-SCRIPT_REQUEST_HISTORY);
        return { ...state, scriptRequests };
      }
      case SCRIPT_RUN_SETTLED: {
        const executionId = readString(event.payload, "executionId");
        if (executionId === undefined) return state;
        return {
          ...state,
          scriptRequests: state.scriptRequests.filter((entry) => entry.executionId !== executionId),
        };
      }
      // Ephemeral chunks must never reach durable state: catch-up reads
      // exclude them, so anything folded from one would diverge on replay.
      case AGENT_LLM_RESPONSE_CHUNKS:
      default:
        return state;
    }
  }

  protected override processEvent(args: ProcessEventArgs<CodemodeInterpreterContract>): undefined {
    const { event, state } = args;
    if (event === null) return;
    switch (event.type) {
      case AGENT_LLM_RESPONSE_CHUNKS:
        this.#streamLiveDeltas(args, event);
        return;
      case AGENT_CONTEXT_ADDED:
        this.#interpretAssistantResponse(args, event, state);
        return;
      case SCRIPT_RUN_SETTLED:
        this.#renderScriptSettlement(args, event);
        return;
      default:
        return;
    }
  }

  /**
   * The live lane: fold the streamed chunk deltas into an in-memory
   * accumulator, classify the text-so-far with the format's partial parser,
   * and re-emit the classification as ephemeral render deltas. Droppable by
   * design — nothing recovers a lost delta because nothing needs to: deltas
   * are cumulative and the durable facts land at settlement.
   */
  #streamLiveDeltas(
    args: ProcessEventArgs<CodemodeInterpreterContract>,
    event: { payload?: Record<string, unknown> },
  ): void {
    if (args.state.interpretResponses) return;
    const payload = event.payload;
    const llmRequestOffset = readNumber(payload, "llmRequestOffset");
    const sequence = readNumber(payload, "sequence");
    if (llmRequestOffset === undefined || sequence === undefined) return;
    let accumulator = this.#live.get(llmRequestOffset);
    if (accumulator === undefined) {
      accumulator = {
        text: "",
        nextSequence: 0,
        poisoned: sequence !== 0,
        lastEmitted: { prose: "", code: "", status: "" },
      };
      this.#live.set(llmRequestOffset, accumulator);
    }
    if (accumulator.poisoned) return;
    if (sequence < accumulator.nextSequence) return; // redelivered flush — already folded
    if (sequence > accumulator.nextSequence) {
      // A gap means earlier chunks are gone (eviction mid-stream; ephemeral
      // events are never redelivered). A partial accumulation would parse
      // into WRONG prose, so this turn skips the pretty live view entirely.
      accumulator.poisoned = true;
      return;
    }
    accumulator.nextSequence = sequence + 1;
    const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
    for (const chunk of chunks) accumulator.text += extractResponseDelta(chunk);
    const view = parseCodemodePartial(accumulator.text);
    const events: Parameters<typeof args.append> = [];
    if (view.prose !== accumulator.lastEmitted.prose) {
      accumulator.lastEmitted.prose = view.prose;
      events.push({
        type: RENDER_MESSAGE_DELTA,
        payload: { llmRequestOffset, text: view.prose },
      });
    }
    const code = view.script?.code || "";
    const status = view.script?.status || "";
    if (
      view.script !== undefined &&
      (code !== accumulator.lastEmitted.code || status !== accumulator.lastEmitted.status)
    ) {
      accumulator.lastEmitted.code = code;
      accumulator.lastEmitted.status = status;
      events.push({
        type: RENDER_SCRIPT_DELTA,
        payload: { llmRequestOffset, code, ...(status === "" ? {} : { status }) },
      });
    }
    if (events.length === 0) return;
    // Droppable attempt: a lost delta is recovered by the NEXT delta (they
    // are cumulative) or, at worst, by the durable facts at settlement.
    args.runInBackground(async () => {
      await args.append(...events);
    });
  }

  /**
   * The durable lane, ported verbatim from the template worker's push-lane
   * interpretation (same gates, same raw idempotency keys) — plus the
   * `source: { offset }` stamp on every consequence, which is what lets
   * renderers treat these as THE feed items and supersede the raw assistant
   * event they derive from.
   */
  #interpretAssistantResponse(
    args: ProcessEventArgs<CodemodeInterpreterContract>,
    event: {
      offset: number;
      createdAt: string;
      payload?: Record<string, unknown>;
      source?: { processor?: { slug: string } };
    },
    state: CodemodeInterpreterState,
  ): void {
    if (state.interpretResponses) return;
    if (readString(event.payload, "role") !== "assistant") return;
    const content = readString(event.payload, "content");
    const llmRequestOffset = readNumber(event.payload, "llmRequestOffset");
    if (content === undefined || llmRequestOffset === undefined) return;
    // Only interpret output the platform's LLM component produced: the stamp
    // means it authored this event for an accepted request. A raw member
    // append carries no platform stamp and must not gain an interpretation.
    if (event.source?.processor?.slug !== AGENT_PROCESSOR_SLUG) return;
    this.#live.delete(llmRequestOffset);
    const outcome = parseCodemodeResponse(content);
    const source = { offset: event.offset };
    // Must-happen appends: losing one silently kills the turn (the exact
    // failure mode of the old observation-grade worker lane). The held frame
    // redelivers on a crash and the raw idempotency keys dedupe the re-run.
    args.blockProcessorWhile(
      this.#appendUnlessAlreadyRecorded(() => {
        if (outcome.kind === "malformed" || outcome.kind === "multiple") {
          const keySuffix =
            outcome.kind === "malformed"
              ? `malformed-snippet-rejected@${event.offset}`
              : `multi-snippet-rejected@${event.offset}`;
          return args.append({
            type: AGENT_CONTEXT_ADDED,
            idempotencyKey: `agent/${keySuffix}`,
            source,
            payload: {
              role: "developer",
              content: outcome.feedback,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          });
        }
        if (outcome.kind === "none") {
          if (outcome.prose === undefined) return Promise.resolve([]);
          return args.append({
            type: AGENT_WEB_MESSAGE_SENT,
            idempotencyKey: `agent/codemode-prose@${event.offset}`,
            source,
            payload: { message: outcome.prose, llmRequestOffset },
          });
        }
        const { code, status, prose } = outcome;
        // Order matters twice over: the status precedes the script so the
        // code step is born with its activity label, and the script precedes
        // the prose so the feed groups the turn as ONE activity.
        return args.append(
          ...(status === undefined
            ? []
            : [
                {
                  type: AGENT_SUMMARY_UPDATED as typeof AGENT_SUMMARY_UPDATED, // pin the literal: a conditional-spread array widens it to string
                  idempotencyKey: `agent/codemode-status@${event.offset}`,
                  source,
                  payload: { activity: status },
                },
              ]),
          {
            type: SCRIPT_RUN_REQUESTED,
            idempotencyKey: `agent/script-run-requested@${event.offset}`,
            source,
            payload: {
              code,
              executionId: `agent-output:${event.offset}`,
              // Anchored to the event, never `now`: redeliveries re-append
              // the identical body and dedupe on the key.
              expiresAt: Date.parse(event.createdAt) + SCRIPT_EXPIRY_MS,
            },
          },
          ...(prose === undefined
            ? []
            : [
                {
                  type: AGENT_WEB_MESSAGE_SENT as typeof AGENT_WEB_MESSAGE_SENT, // pin the literal: a conditional-spread array widens it to string
                  idempotencyKey: `agent/codemode-prose@${event.offset}`,
                  source,
                  payload: { message: prose, llmRequestOffset },
                },
              ]),
        );
      }),
    );
  }

  /**
   * The "tool result" half of the loop, ported from the template worker: a
   * settled execution renders back as developer context with
   * after-current-request, which drives the agent's next turn. Duration
   * comes from the reduced scriptRequests entry (journaled createdAt diff —
   * deterministic), replacing the old lane's per-settlement stream read.
   */
  #renderScriptSettlement(
    args: ProcessEventArgs<CodemodeInterpreterContract>,
    event: { offset: number; createdAt: string; payload?: Record<string, unknown> },
  ): void {
    const executionId = readString(event.payload, "executionId");
    const settlement = readRecord(event.payload, "settlement");
    if (executionId === undefined || settlement === undefined) return;
    if (!executionId.startsWith("agent-output:")) return;
    // Reduce already removed this settlement's entry from the CURRENT state,
    // so read the duration from the pre-reduce state the runner hands us.
    const requested = args.previousState.scriptRequests.find(
      (entry) => entry.executionId === executionId,
    );
    const ranIn =
      requested === undefined
        ? null
        : formatDuration(Date.parse(event.createdAt) - Date.parse(requested.requestedAt));
    // Must-happen append: without the rendered result the agent never takes
    // its next turn. Held frame + raw shared key, as in the interpret lane.
    args.blockProcessorWhile(
      this.#appendUnlessAlreadyRecorded(async () => {
        let content: string;
        if (settlement.status === "failed") {
          const note = settlement.executionMayHaveOccurred
            ? "The script may have partially executed; inspect state before retrying."
            : "The script did not execute.";
          const error = typeof settlement.error === "string" ? settlement.error : "unknown error";
          const phase = typeof settlement.phase === "string" ? settlement.phase : "execution";
          const failureKind =
            typeof settlement.failureKind === "string" ? settlement.failureKind : "unknown";
          content =
            `Your script failed during ${phase} (${failureKind}${ranIn === null ? "" : `, after ${ranIn}`}):\n` +
            `\`\`\`\n${truncate(error)}\n\`\`\`\n${note}\n` +
            `Before retrying: \`await itx.docs.typecheck({ code })\` compiles a script against this ` +
            `scope's real types, and \`await itx.docs.search({ q: "several related words" })\` finds working examples.`;
        } else {
          if (settlement.result === undefined) return [];
          const isRawText = typeof settlement.result === "string";
          const text = isRawText
            ? (settlement.result as string) // narrowed by isRawText on the previous line
            : JSON.stringify(settlement.result, null, 2);
          content = await this.#renderResult({ executionId, isRawText, ranIn, text });
        }
        return args.append({
          type: AGENT_CONTEXT_ADDED,
          idempotencyKey: `agent/render-script-result@${event.offset}`,
          source: { offset: event.offset },
          payload: {
            role: "developer",
            content,
            actor: { type: "script", executionId },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        });
      }),
    );
  }

  /**
   * An oversized result SPILLS to the agent's own workspace (mirroring the
   * platform codemode component): the inline copy becomes a preview plus a
   * read-it-back recipe. Best-effort — a workspace that cannot write falls
   * back to inline truncation.
   */
  async #renderResult(input: {
    executionId: string;
    isRawText: boolean;
    ranIn: string | null;
    text: string;
  }): Promise<string> {
    const { executionId, isRawText, ranIn, text } = input;
    const returnedHeader = `Your script returned${ranIn === null ? "" : ` (in ${ranIn})`}:`;
    const fence = isRawText ? "```" : "```json";
    if (text.length <= RESULT_HISTORY_LIMIT) {
      return `${returnedHeader}\n${fence}\n${text}\n\`\`\``;
    }
    try {
      // One file per execution, so replays overwrite idempotently. The agent
      // workspace lives at /workspaces/<agent path>; relative paths in the
      // agent's own scripts resolve there, so the recipe uses the relative form.
      const relativePath = `script-results/${executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.${isRawText ? "txt" : "json"}`;
      const workspace = `/workspaces${this.path}`;
      await this.#hostDeps.writeWorkspaceFile(workspace, `${workspace}/${relativePath}`, text);
      const shown = text.slice(0, RESULT_SPILL_PREVIEW_CHARS);
      return [
        returnedHeader,
        fence,
        shown,
        "```",
        `…truncated: showing the first ${shown.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(relativePath)} — don't re-fetch; read and filter it with plain TypeScript in your next script, e.g.:`,
        "```ts",
        isRawText
          ? `const text = await itx.workspace.readFile(${JSON.stringify(relativePath)});`
          : `const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(relativePath)}));`,
        "```",
      ].join("\n");
    } catch (error) {
      console.error("[codemode-interpreter] failed to spill oversized script result", { error });
      return `${returnedHeader}\n${fence}\n${truncate(text)}\n\`\`\``;
    }
  }

  /** An idempotency conflict means another writer (a redelivery of ourselves,
   * the platform component during the birth race, or the old worker lane
   * before the facet took over) already recorded this consequence — losing
   * that race is success. */
  #appendUnlessAlreadyRecorded(append: () => Promise<unknown>): () => Promise<void> {
    return async () => {
      try {
        await append();
      } catch (error) {
        if (!isIdempotencyConflict(error)) throw error;
      }
    };
  }
}

/**
 * The facet hosting one interpreter per agent stream, placed INSIDE that
 * stream's own Durable Object (facet-processor receiver). StreamProcessorFacet
 * carries the placement protocol: identity arrives through the parent's
 * first-contact configure() call, and alarms proxy through the parent (facets
 * have no native alarms).
 */
export class CodemodeInterpreterFacet extends StreamProcessorFacet {
  /** The interpreter's appends ride blockProcessorWhile — registered work the
   * keepalive must revive after an eviction. */
  protected override readonly recovery = true;

  protected createProcessor(deps: ProcessorHostDeps) {
    return new CodemodeInterpreterProcessor(deps, {
      writeWorkspaceFile: async (workspacePath, filePath, content) => {
        using project = await this.env.ITX.get();
        await project.workspaces.get(workspacePath).writeFile(filePath, content);
      },
    });
  }
}

/** The response-text delta inside one streamed LLM chunk. Vendored (trimmed
 * to the response half) from packages/ui agent-ui-reducer's
 * extractCloudflareChunkDeltas — the template cannot import packages/ui.
 * Covers the vendor dialects the platform journals: Workers AI
 * `{response}`, OpenAI chat completions `{choices:[{delta:{content}}]}`,
 * Anthropic `{delta:{text}}`. */
function extractResponseDelta(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object" || chunk === null) return "";
  const record = chunk as Record<string, unknown>; // narrowed by the typeof/null checks above
  if (typeof record.response === "string") return record.response;
  if (
    Array.isArray(record.choices) &&
    typeof record.choices[0] === "object" &&
    record.choices[0] !== null
  ) {
    const delta = (record.choices[0] as Record<string, unknown>).delta; // element narrowed above
    if (typeof delta === "object" && delta !== null) {
      const content = (delta as Record<string, unknown>).content; // narrowed above
      return typeof content === "string" ? content : "";
    }
    return "";
  }
  if (typeof record.delta === "object" && record.delta !== null) {
    const text = (record.delta as Record<string, unknown>).text; // narrowed above
    return typeof text === "string" ? text : "";
  }
  return "";
}

function formatDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 120_000) return `${Math.round(durationMs / 100) / 10}s`;
  // Round to whole seconds BEFORE splitting into minutes: otherwise 179.7s
  // renders "2m 60s".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function truncate(text: string): string {
  if (text.length <= RESULT_HISTORY_LIMIT) return text;
  return `${text.slice(0, RESULT_HISTORY_LIMIT)}\n… truncated (${text.length} chars total — return less: slice arrays, pick fields)`;
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecordValue(value);
  const found = record?.[key];
  return typeof found === "string" ? found : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const record = readRecordValue(value);
  const found = record?.[key];
  return typeof found === "number" ? found : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = readRecordValue(value);
  return readRecordValue(record?.[key]);
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>; // narrowed by the checks above
}

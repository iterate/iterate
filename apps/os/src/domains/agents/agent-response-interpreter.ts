// The agent's RESPONSE INTERPRETATION service — the platform-implemented
// half of "interpretation is userland's decision". Formerly the codemode
// COMPONENT composed into the classic agent processor (agent-codemode.ts,
// deleted in the birth-userland refactor); now nothing platform-side ever
// interprets on its own: project code (typically the config worker's
// processEvent) calls `itx.agents.get(path).interpretResponse(event)` per
// event, and THIS module decides what that event means and which appends
// follow. Platform-implemented on purpose — it live-updates on platform
// deploy, its output events cannot drift from the platform vocabulary, and
// the appends happen next to the stream — but the platform never decides to
// call it. Pinning behavior = vendoring your own interpreter in the config
// repo (see configs/codemode-tag).
//
// Everything opinion-shaped from the classic processor lives here: slash
// commands (user text → script, no LLM), response parsing (accepted assistant
// output → one script via the response format, or corrective feedback),
// settlement rendering (script result → developer context that drives the
// next turn, spilling oversized results to the agent's workspace), preamble
// transcription, stream-error transcription, and the qualifying-wake waiting
// clear. Idempotency keys mint in the same fixed `agent/` namespace the
// classic component used, so redelivered worker handlers (and historical
// streams interpreted twice) converge instead of double-executing.

import type { EmittedInput, StreamEvent } from "iterate/processors";
import { inferJsonType } from "../../lib/infer-json-type.ts";
import { stringifyScriptResult, truncateScriptResult } from "../../lib/script-result-render.ts";
import { previewJson } from "../../lib/truncate-json.ts";
import { INLINE_RESULT_PREAMBLE_LIMIT } from "../capability-host/capability-host-preamble.ts";
import { AGENT_KEEPER_SUBSCRIPTION_NAME } from "./agent-defaults.ts";
import { AgentProcessorContract, type AgentProcessorState } from "./agent-processor-contract.ts";
import { contextClearsWaitingFor } from "./agent-prompt-fold.ts";
import { fencedTsResponseFormat, type AgentResponseFormat } from "./agent-response-format.ts";
import {
  buildSlashCommandCode,
  resolveSlashCommand,
  SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX,
  SLASH_COMMAND_EXECUTION_PREFIX,
} from "./slash-commands.ts";

/** The context-added payload schema, straight off the contract — defaults
 * applied, so the resolver/clear predicates see what the fold saw. */
const AgentContextAddedSchema =
  AgentProcessorContract.events["events.iterate.com/agents/context-added"].payloadSchema;

/** What the interpreter borrows from its host beyond the event and state. */
export type AgentInterpreterDeps = {
  /** Writes one file into THIS agent's own workspace directory so oversized
   * script results can spill to a file the model pages through. Optional:
   * without it, oversized results fall back to inline truncation. */
  writeWorkspaceFile?: (input: {
    content: string;
    path: string;
  }) => Promise<{ absolutePath: string }>;
};

/**
 * Interpret ONE committed event against the agent's current reduced state,
 * returning the appends that carry its consequences — idempotency-keyed, so
 * the caller appends them race-tolerantly and repeated interpretation of the
 * same event converges. Events outside the interpreter's vocabulary return
 * an empty list; interpretation is per-event and stateless between calls.
 */
export async function interpretAgentEvent(input: {
  event: StreamEvent;
  state: AgentProcessorState;
  deps: AgentInterpreterDeps;
  /** The response grammar. Defaults to the classic fenced-```ts format. */
  format?: AgentResponseFormat;
}): Promise<EmittedInput<AgentProcessorContract>[]> {
  const { event, state, deps } = input;
  const format = input.format ?? fencedTsResponseFormat;
  switch (event.type) {
    case "events.iterate.com/agents/context-added": {
      // Parse through the contract's own payload schema (defaults applied),
      // so the resolver and clear predicates see exactly what the fold saw.
      // A malformed raw append is a fact of the log, not an exception.
      const parsedPayload = AgentContextAddedSchema.safeParse(event.payload);
      if (!parsedPayload.success) return [];
      const payload = parsedPayload.data;
      const appends: EmittedInput<AgentProcessorContract>[] = [];
      // WAITING CLEAR — a qualifying wake retires an agent-authored
      // "waiting for input" summary. The conditional-clear payload carries
      // the waking offset, so the fold only clears a wait established at or
      // before it (a wait the agent set AFTER this input raced in survives —
      // the state snapshot here may be newer than the event, and that guard
      // is what keeps the late look harmless).
      if (state.summary.waitingFor !== undefined && contextClearsWaitingFor(payload)) {
        appends.push({
          type: "events.iterate.com/agent/summary-updated",
          payload: { waitingFor: null, clearWaitingForThroughOffset: event.offset },
          idempotencyKey: `agent/waiting-clear@${event.offset}`,
        });
      }
      // SLASH COMMANDS — a user message that resolves to a known command
      // runs as a codemode script with this agent's provenance instead of
      // triggering an LLM turn (the fold's contextTriggerSource skips it via
      // the SAME pure resolver, and the turn loop's interrupt defers to it
      // the same way, so the three can never disagree). Deterministic body
      // (expiry anchored to the event, never `now`) so repeated
      // interpretation dedupes on the key. Non-resolving "/..." text falls
      // through to the model untouched.
      if (payload.role === "user") {
        const slashCommand = resolveSlashCommand(payload.content);
        if (slashCommand !== null) {
          const executionId = `${SLASH_COMMAND_EXECUTION_PREFIX}${slashCommand.command}:${event.offset}`;
          appends.push({
            type: "events.iterate.com/capability-host/script-run-requested",
            payload: {
              code: buildSlashCommandCode(slashCommand, executionId),
              executionId,
              expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
            },
            idempotencyKey: `agent/slash-command@${event.offset}`,
          });
          return appends;
        }
      }
      // RESPONSE PARSING — an accepted assistant output may carry ONE
      // codemode script. WHAT the response means is the response format's
      // decision (agent-response-format.ts); mapping the outcome to appends
      // stays here so every side effect keeps the idempotency discipline.
      // Two gates make only REAL keeper output executable:
      // - the keeper's processor stamp — a raw member append of
      //   assistant-role history (even one carrying a numeric
      //   llmRequestOffset) never gains a path to capability execution, and
      //   output another interpreter already handled elsewhere is theirs;
      // - presence in the reduced contextItems — assistant output whose
      //   request an interrupt closed reduced to nothing and must not run.
      if (
        payload.role === "assistant" &&
        typeof payload.llmRequestOffset === "number" &&
        event.source?.processor?.slug === AGENT_KEEPER_SUBSCRIPTION_NAME &&
        state.contextItems.some((item) => item.offset === event.offset)
      ) {
        const outcome = format.parse(payload.content);
        if (outcome.kind === "malformed" || outcome.kind === "multiple") {
          const idempotencyKeySuffix =
            outcome.kind === "malformed"
              ? `malformed-snippet-rejected@${event.offset}`
              : `multi-snippet-rejected@${event.offset}`;
          appends.push({
            type: "events.iterate.com/agents/context-added",
            payload: {
              role: "developer",
              content: outcome.feedback,
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
            idempotencyKey: `agent/${idempotencyKeySuffix}`,
          });
        } else if (outcome.kind === "script") {
          appends.push({
            // Deterministic body (expiresAt anchors to the assistant event,
            // never `now`): repeated interpretation re-produces the identical
            // request and dedupes on the key.
            type: "events.iterate.com/capability-host/script-run-requested",
            payload: {
              code: outcome.code,
              executionId: `agent-output:${event.offset}`,
              expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
            },
            idempotencyKey: `agent/script-run-requested@${event.offset}`,
          });
        }
      }
      return appends;
    }
    case "events.iterate.com/capability-host/preamble-set":
    case "events.iterate.com/capability-host/preamble-removed": {
      // Preamble changes on this agent's scope transcribe into developer
      // context — the model can only use symbols it knows exist. Never a
      // turn trigger: when the agent's own script set the entry, the
      // script's settlement drives the next turn; an external set is
      // configuration, not conversation.
      const payload = event.payload as { key?: unknown; code?: unknown };
      if (typeof payload.key !== "string") return [];
      const isSet = event.type === "events.iterate.com/capability-host/preamble-set";
      const content = isSet
        ? `Preamble entry ${JSON.stringify(payload.key)} was set. This TypeScript is now injected above your scripts — its symbols are in scope:\n\`\`\`ts\n${typeof payload.code === "string" ? payload.code : ""}\n\`\`\``
        : `Preamble entry ${JSON.stringify(payload.key)} was removed; its symbols are no longer available to your scripts.`;
      return [
        {
          type: "events.iterate.com/agents/context-added",
          payload: {
            role: "developer",
            content,
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
          idempotencyKey: `agent/render-preamble-change@${event.offset}`,
        },
      ];
    }
    case "events.iterate.com/capability-host/script-run-settled": {
      const payload = event.payload as {
        executionId?: string;
        settlement?: Parameters<typeof renderScriptSettlement>[0]["settlement"];
      };
      const { executionId, settlement } = payload;
      if (executionId === undefined || settlement === undefined) return [];
      // Only executions the agent lane requested render back into the
      // conversation — the executionId prefixes ARE the membership rule
      // (other scripts, e.g. Slack bang commands, record on the same
      // stream and stay invisible).
      if (
        !executionId.startsWith("agent-output:") &&
        !executionId.startsWith(SLASH_COMMAND_EXECUTION_PREFIX)
      ) {
        return [];
      }
      // `/script` publishes its successful result directly as interruptive
      // context, then returns the same value so the capability host keeps it
      // in the script-results preamble. Only its failures render here.
      if (
        executionId.startsWith(SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX) &&
        settlement.status === "succeeded"
      ) {
        return [];
      }
      // Rendering may first spill an oversized result into the agent's
      // workspace (a durable write) — the input must not land before the
      // file it references, so the write happens here, before the append.
      const content = await renderScriptSettlement({
        executionId,
        settlement,
        historyLimit: state.config.scriptResultHistoryLimit,
        writeWorkspaceFile: deps.writeWorkspaceFile,
      });
      if (content === null) return [];
      return [
        {
          type: "events.iterate.com/agents/context-added",
          payload: {
            role: "developer",
            content,
            actor: { type: "script", executionId },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
          idempotencyKey: `agent/render-script-result@${event.offset}`,
        },
      ];
    }
    case "events.iterate.com/stream/error-occurred": {
      // EVERY error on the stream — the LLM component's own failures, the
      // sender's repeatedly failing skipped events, anything else — can be
      // transcribed into model-visible context, without itself triggering a
      // turn (retries are the reduce's job). The integration actor demotes
      // the error text to user role at prompt time: error strings are data,
      // not instructions.
      const payload = event.payload as { message?: unknown };
      if (typeof payload.message !== "string") return [];
      return [
        {
          type: "events.iterate.com/agents/context-added",
          payload: {
            role: "developer",
            content: `Error on stream: ${payload.message}`,
            actor: { type: "integration", name: "stream-error" },
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
          idempotencyKey: `agent/transcribe-error@${event.offset}`,
        },
      ];
    }
    default:
      return [];
  }
}

// -----------------------------------------------------------------------------
// Settlement rendering: script results back into inputs.
// -----------------------------------------------------------------------------

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions the agent lane did not request stay invisible (the caller
//   filters by executionId prefix before ever calling this);
// - a script that returned undefined and did not throw produces nothing.
//   Returning no value is how an agent ends its turn.
async function renderScriptSettlement(input: {
  executionId: string;
  settlement: {
    status: "succeeded" | "failed";
    result?: unknown;
    error?: string;
    phase?: string;
    failureKind?: string;
    executionMayHaveOccurred?: boolean;
  };
  historyLimit: number;
  writeWorkspaceFile: AgentInterpreterDeps["writeWorkspaceFile"];
}): Promise<string | null> {
  const { executionId, settlement, historyLimit, writeWorkspaceFile } = input;
  if (settlement.status === "failed") {
    // Advertise the recovery tools at the moment of failure — a wrong call
    // is exactly when docs.typecheck's did-you-mean and docs.search's
    // working examples pay off, and nothing else tells the model they exist.
    const executionNote = settlement.executionMayHaveOccurred
      ? "The script may have partially executed; inspect state before retrying."
      : "The script did not execute.";
    return (
      `Your script failed during ${settlement.phase} (${settlement.failureKind}):\n` +
      `\`\`\`\n${truncateScriptResult(settlement.error ?? "unknown error", historyLimit)}\n\`\`\`\n${executionNote}\n` +
      `Before retrying: \`await itx.docs.typecheck({ code })\` compiles a script against this ` +
      `scope's real types (typos come back as "did you mean …"), and ` +
      `\`await itx.docs.search({ q: "several related words" })\` finds working examples.`
    );
  }
  if (settlement.result === undefined) return null;
  const text = stringifyScriptResult(settlement.result);
  // The preamble binding this exact result got: the SAME compact-JSON split
  // the capability host applies when deriving the `results` array. NOT the
  // spill decision below — that keys on pretty-printed length vs the
  // configured historyLimit, so a result can spill to a file yet still be an
  // inline `data` row (no `.load`); a recipe naming the wrong member fails
  // typecheck in the very next script.
  const resultsAccess =
    JSON.stringify(settlement.result).length <= INLINE_RESULT_PREAMBLE_LIMIT ? "data" : "load";
  const preambleNote =
    resultsAccess === "data"
      ? "\nThis result is available to your next script as `results[0].data` (the preamble `results` array, newest first)."
      : "\nThe full result is available to your next script via `await results[0].load(itx)` (the preamble `results` array, newest first).";
  // String results are raw text, not JSON — the fence label, the spill
  // file's extension, and the read-it-back recipe all say so honestly.
  const isRawText = typeof settlement.result === "string";
  const fence = isRawText ? "```" : "```json";
  if (text.length > historyLimit && writeWorkspaceFile !== undefined) {
    try {
      const spilledPath = await spillScriptResult({
        executionId,
        extension: isRawText ? "txt" : "json",
        text,
        writeWorkspaceFile,
      });
      // Once the full result is safely on disk, the inline copy stops trying
      // to be the data and becomes a map of it: shrink hard (well under
      // historyLimit) and spend the space on shape instead of payload.
      if (isRawText) {
        const shownChars = Math.min(OVERSIZED_RAW_TEXT_PREVIEW_CHARS, historyLimit);
        return [
          "Your script returned:",
          "```",
          text.slice(0, shownChars),
          "```",
          rawTextSpillNotice({
            path: spilledPath,
            resultsAccess,
            shownChars,
            totalChars: text.length,
          }),
        ].join("\n");
      }
      return renderOversizedJsonResult({
        historyLimit,
        path: spilledPath,
        result: settlement.result,
        resultsAccess,
        text,
      });
    } catch (error) {
      // Spilling is best effort: a workspace that cannot clone or write must
      // not lose the result entirely — fall through to inline truncation.
      console.error("[agent] failed to spill oversized script result to workspace", {
        error,
        executionId,
      });
    }
  }
  return `Your script returned:\n${fence}\n${truncateScriptResult(text, historyLimit)}\n\`\`\`${preambleNote}`;
}

/**
 * Where oversized script results land, relative to the agent's own workspace
 * directory: private scratch files for the model to page through with
 * itx.workspace, under no mount and therefore never committable. One file per
 * execution, so replays overwrite idempotently. Size is no concern —
 * workspace files past the inline threshold are stored in R2 transparently.
 */
const SCRIPT_RESULT_SPILL_DIR = "script-results";

/** Writes the full result text into the agent's workspace directory; returns
 * the fully-qualified workspace path. */
async function spillScriptResult(input: {
  executionId: string;
  extension: "json" | "txt";
  text: string;
  writeWorkspaceFile: NonNullable<AgentInterpreterDeps["writeWorkspaceFile"]>;
}): Promise<string> {
  const path = `${SCRIPT_RESULT_SPILL_DIR}/${input.executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.${input.extension}`;
  const written = await input.writeWorkspaceFile({ content: input.text, path });
  return written.absolutePath;
}

/** Inline budgets for an oversized result once the full copy is spilled: the
 * inferred type and shape-preserving preview replace raw payload — the model
 * reads the spill file when it needs actual data, so keep history lean. */
const OVERSIZED_RAW_TEXT_PREVIEW_CHARS = 10_000;
const OVERSIZED_TYPE_MAX_CHARS = 3_000;
const OVERSIZED_JSON_PREVIEW_MAX_BYTES = 8_000;

/**
 * Oversized JSON result, spilled successfully: render an inferred TypeScript
 * type (the whole shape, cheap) plus an aggressively elided preview (a few
 * items per array, capped strings/depth) plus the read-it-back recipe. Both
 * smart parts degrade independently — a value that defeats inference or
 * previewing still renders the other, or falls back to a plain slice.
 */
function renderOversizedJsonResult(input: {
  historyLimit: number;
  path: string;
  result: unknown;
  /** Which member the preamble `results` row for THIS result actually has —
   * `data` (inline literal) or `load` (typed async loader); the recipe must
   * name the one that exists or the next script fails typecheck. */
  resultsAccess: "data" | "load";
  text: string;
}): string {
  let typeText: string | null = null;
  try {
    typeText = inferJsonType(input.result, {
      maxChars: Math.min(OVERSIZED_TYPE_MAX_CHARS, input.historyLimit),
    });
  } catch (error) {
    console.error("[agent] failed to infer type for oversized script result", { error });
  }
  let previewText: string;
  try {
    const preview = previewJson(input.result, {
      maxArrayItems: 3,
      maxBytes: Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, input.historyLimit),
      maxDepth: 5,
      maxStringChars: 500,
    });
    previewText = JSON.stringify(preview.value, null, 2);
  } catch (error) {
    console.error("[agent] failed to build preview for oversized script result", { error });
    previewText = `${input.text.slice(0, Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, input.historyLimit))}\n… (cut mid-document)`;
  }
  return [
    `Your script returned ${input.text.length.toLocaleString("en-US")} chars of JSON — over the ~${input.historyLimit.toLocaleString("en-US")}-char inline limit.${typeText === null ? "" : " Inferred type:"}`,
    ...(typeText === null ? [] : ["```ts", `type Result = ${typeText}`, "```"]),
    "Preview (long arrays/strings elided):",
    "```json",
    previewText,
    "```",
    "The full result is available to your next script through the preamble `results` array — don't re-fetch:",
    "```ts",
    "async (itx) => {",
    input.resultsAccess === "load"
      ? "  const data = await results[0].load(itx); // newest first; typed — the full result"
      : "  const data = results[0].data; // newest first; the full result, typed by its literal",
    "  // filter/pick with plain TypeScript and return only what you need",
    "}",
    "```",
    `(The full copy is also saved in your workspace at ${JSON.stringify(input.path)} — use itx.workspace to page a slice if that suits better.)`,
  ].join("\n");
}

/**
 * The model-facing text after a truncated raw-text preview: where the full
 * result lives and a concrete next-script recipe for paging it, so the model
 * reads the file with plain TypeScript instead of re-running the expensive
 * fetch.
 */
function rawTextSpillNotice(input: {
  path: string;
  /** See renderOversizedJsonResult: the member this result's preamble row has. */
  resultsAccess: "data" | "load";
  shownChars: number;
  totalChars: number;
}): string {
  return [
    `…truncated: showing the first ${input.shownChars.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full text is available to your next script through the preamble \`results\` array — don't re-fetch:`,
    "```ts",
    "async (itx) => {",
    input.resultsAccess === "load"
      ? "  const text = await results[0].load(itx); // newest first — the full string"
      : "  const text = results[0].data; // newest first — the full string",
    `  return text.slice(${input.shownChars}, ${input.shownChars * 4}); // page/regex to return only what you need`,
    "}",
    "```",
    `(The full copy is also saved in your workspace at ${JSON.stringify(input.path)}.)`,
  ].join("\n");
}

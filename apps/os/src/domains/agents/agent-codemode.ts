// The agent's CODEMODE part — one of the three parts of the agent processor
// (see agent-processor-implementation.ts), and the one that is CONFIGURABLE:
// everything that turns text into itx scripts and script results back into
// conversation. Slash commands (user text → script, no LLM), response
// parsing (accepted assistant output → one script via the fenced-ts response
// format, or corrective feedback), and settlement rendering (script result →
// developer context that drives the next turn, spilling oversized results to
// the agent's workspace). With `config.interpretResponses` off the processor
// never calls this part — project code consumes the raw assistant output
// events and appends these same consequences itself.

import type { ProcessEventArgs } from "iterate/processors";
import { inferJsonType } from "../../lib/infer-json-type.ts";
import { stringifyScriptResult, truncateScriptResult } from "../../lib/script-result-render.ts";
import { previewJson } from "../../lib/truncate-json.ts";
import { INLINE_RESULT_PREAMBLE_LIMIT } from "../capability-host/capability-host-preamble.ts";
import {
  appendUnlessLostIdempotencyRace,
  type AgentHost,
  type AgentProcessorDeps,
} from "./agent-host.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";
import { deriveRole, modelOutputRequestOffset } from "./agent-prompt-fold.ts";
import { fencedTsResponseFormat } from "./agent-response-format.ts";
import {
  buildSlashCommandCode,
  resolveSlashCommand,
  SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX,
  SLASH_COMMAND_EXECUTION_PREFIX,
} from "./slash-commands.ts";

export class AgentCodemode {
  readonly #host: AgentHost;
  readonly #format = fencedTsResponseFormat;

  constructor(host: AgentHost) {
    this.#host = host;
  }

  // Called by the owning processor for every delivery — ONLY while
  // `config.interpretResponses` is on (the gate lives at the composition
  // point, agent-processor-implementation.ts).
  processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { event, previousState, state, blockProcessorWhile, append } = args;
    switch (event?.type) {
      case "events.iterate.com/agents/context-added": {
        const payload = event.payload;
        // SLASH COMMANDS — a user message that resolves to a known command
        // runs as a codemode script with this agent's provenance instead of
        // triggering an LLM turn (contextTriggerSource skips it via the SAME
        // pure resolver, and the turn loop's interrupt defers to it the same
        // way, so the three can never disagree). Blocked per-event
        // consequence with the assistant-script path's discipline:
        // deterministic body (expiry anchored to the event, never `now`) so
        // an at-least-once redelivery dedupes on the key, race-tolerant for
        // a config change between deliveries. Non-resolving "/..." text falls
        // through to the model untouched.
        if (deriveRole(payload) === "user") {
          const slashCommand = resolveSlashCommand(payload.content);
          if (slashCommand !== null) {
            const executionId = `${SLASH_COMMAND_EXECUTION_PREFIX}${slashCommand.command}:${event.offset}`;
            blockProcessorWhile(() =>
              appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/capability-host/script-run-requested",
                  payload: {
                    code: buildSlashCommandCode(slashCommand, executionId),
                    executionId,
                    expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
                  },
                  idempotencyKey: this.#host.idempotencyKey(`slash-command@${event.offset}`),
                },
              ]),
            );
            break;
          }
        }
        // RESPONSE PARSING — an accepted assistant output may carry ONE
        // codemode script; extraction rides the same delivery that reduced the
        // text. WHAT the response means is the response format's decision
        // (agent-response-format.ts); mapping the outcome to appends stays
        // here so every side effect keeps the processor's idempotency and
        // blocking discipline. Only output linked to THE open request is
        // executable: a caller may raw-append model-output history, and may
        // even supply a numeric request offset, without thereby gaining a
        // path to capability execution. Blocked for the same per-event reason
        // as the slash path: this event is delivered once, and both the
        // script request and the corrective feedback would be lost forever
        // with it.
        const outputRequestOffset = modelOutputRequestOffset(payload);
        if (
          outputRequestOffset !== undefined &&
          outputRequestOffset === state.openRequest?.requestedAtOffset
        ) {
          const outcome = this.#format.parse(payload.content);
          if (outcome.kind === "malformed" || outcome.kind === "multiple") {
            const idempotencyKeySuffix =
              outcome.kind === "malformed"
                ? `malformed-snippet-rejected@${event.offset}`
                : `multi-snippet-rejected@${event.offset}`;
            blockProcessorWhile(() =>
              appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/agents/context-added",
                  payload: {
                    content: outcome.feedback,
                    actor: { type: "platform" },
                    llmRequestPolicy: { behaviour: "after-current-request" },
                  },
                  idempotencyKey: this.#host.idempotencyKey(idempotencyKeySuffix),
                },
              ]),
            );
          } else if (outcome.kind === "script") {
            blockProcessorWhile(() =>
              // Deterministic body (expiresAt anchors to the assistant event,
              // never `now`): an at-least-once redelivery of this event
              // re-appends the identical request and dedupes on the key —
              // a `now`-stamped expiry would make the re-append a same-key
              // CONFLICT and wedge the frame forever. The race-tolerant
              // append covers a config change between deliveries.
              appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/capability-host/script-run-requested",
                  payload: {
                    code: outcome.code,
                    executionId: `agent-output:${event.offset}`,
                    expiresAt: Date.parse(event.createdAt) + state.config.llmRequestExpiryMs,
                  },
                  idempotencyKey: this.#host.idempotencyKey(`script-run-requested@${event.offset}`),
                },
              ]),
            );
          }
        }
        break;
      }
      case "events.iterate.com/capability-host/preamble-set":
      case "events.iterate.com/capability-host/preamble-removed": {
        // Preamble changes on this agent's scope transcribe into developer
        // context — the model can only use symbols it knows exist. Never a
        // turn trigger: when the agent's own script set the entry, the
        // script's settlement drives the next turn; an external set is
        // configuration, not conversation. Blocked: per-event consequence,
        // delivered once.
        const isSet = event.type === "events.iterate.com/capability-host/preamble-set";
        const content = isSet
          ? `Preamble entry ${JSON.stringify(event.payload.key)} was set. This TypeScript is now injected above your scripts — its symbols are in scope:\n\`\`\`ts\n${event.payload.code}\n\`\`\``
          : `Preamble entry ${JSON.stringify(event.payload.key)} was removed; its symbols are no longer available to your scripts.`;
        blockProcessorWhile(() =>
          appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                content,
                actor: { type: "platform" },
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
              idempotencyKey: this.#host.idempotencyKey(`render-preamble-change@${event.offset}`),
            },
          ]),
        );
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        const { executionId, settlement } = event.payload;
        // Settlement reduction removes the execution from `state`, so inspect
        // the immediately preceding projection. Only a request provenance-
        // stamped by this agent processor can enter that active set.
        const execution = previousState.activeScriptExecutions.find(
          (candidate) => candidate.executionId === executionId,
        );
        if (execution === undefined) break;
        // `/script` publishes its successful result directly as interruptive
        // context, then returns the same value so the capability host keeps it
        // in the script-results preamble. Only its failures render here.
        if (
          executionId.startsWith(SCRIPT_SLASH_COMMAND_EXECUTION_PREFIX) &&
          settlement.status === "succeeded"
        ) {
          break;
        }
        // Per-event render (blocked): the settlement is delivered once, and a
        // lost render would silently drop the script's result from the
        // conversation. Rendering may first spill an oversized result into
        // the agent's workspace (a durable write that can wait on the
        // checkout's first-use clone), so the whole render-then-append runs
        // inside the blocking section — the input must not land before the
        // file it references. Race-tolerant: a truncation-limit config change
        // between redeliveries alters the rendered body under the same key.
        blockProcessorWhile(async () => {
          const content = await renderScriptSettlement({
            executionId,
            settlement,
            // How long the script ran, derived from the requested and settled
            // events' own journaled createdAt — deterministic across
            // redeliveries and replays, never wall clock.
            durationMs: Math.max(
              0,
              Date.parse(event.createdAt) - Date.parse(execution.requestedAt),
            ),
            historyLimit: state.config.scriptResultHistoryLimit,
            writeWorkspaceFile: this.#host.deps.writeWorkspaceFile,
          });
          if (content === null) return;
          await appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                content,
                actor: { type: "script", executionId },
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
              idempotencyKey: this.#host.idempotencyKey(`render-script-result@${event.offset}`),
            },
          ]);
        });
        break;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Settlement rendering: script results back into inputs.
// -----------------------------------------------------------------------------

// The "tool result" half of the codemode loop: a finished script execution
// renders back into model-visible history so the next turn can look at the
// data. Two deliberate gaps end the loop instead of feeding it:
// - executions this agent did not request stay invisible (other scripts —
//   e.g. Slack bang commands — record on the same stream; the caller
//   filters by the `agent-output:` prefix before ever calling this);
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
  /** How long the script ran — derived by the caller from the requested and
   * settled events' journaled createdAt, so slow operations become knowable
   * to the model. */
  durationMs: number;
  historyLimit: number;
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"];
}): Promise<string | null> {
  const { executionId, settlement, historyLimit, writeWorkspaceFile } = input;
  const ranIn = formatScriptDuration(input.durationMs);
  if (settlement.status === "failed") {
    // Advertise the recovery tools at the moment of failure — a wrong call
    // is exactly when docs.typecheck's did-you-mean and docs.search's
    // working examples pay off, and nothing else tells the model they exist.
    const executionNote = settlement.executionMayHaveOccurred
      ? "The script may have partially executed; inspect state before retrying."
      : "The script did not execute.";
    return (
      `Your script failed during ${settlement.phase} (${settlement.failureKind}, after ${ranIn}):\n` +
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
          `Your script returned (in ${ranIn}):`,
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
        ranIn,
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
  return `Your script returned (in ${ranIn}):\n${fence}\n${truncateScriptResult(text, historyLimit)}\n\`\`\`${preambleNote}`;
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
  writeWorkspaceFile: NonNullable<AgentProcessorDeps["writeWorkspaceFile"]>;
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
  /** Formatted script duration ("1.8s"), rendered into the header line. */
  ranIn: string;
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
    `Your script returned ${input.text.length.toLocaleString("en-US")} chars of JSON (in ${input.ranIn}) — over the ~${input.historyLimit.toLocaleString("en-US")}-char inline limit.${typeText === null ? "" : " Inferred type:"}`,
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

/** Human-scale script duration for the settlement render: "840ms", "1.8s",
 * "2m 5s". The codemode-tag template's vendored settlement renderer carries
 * its own copy of this. */
function formatScriptDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 120_000) return `${Math.round(durationMs / 100) / 10}s`;
  // Round to whole seconds BEFORE splitting into minutes: rounding the
  // leftover afterwards turns 179.7s into "2m 60s" instead of "3m".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

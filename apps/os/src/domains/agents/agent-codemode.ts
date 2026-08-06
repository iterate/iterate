// The agent's CODEMODE component — one of the three parts composed into the
// agent processor (see agent-processor-implementation.ts), and the one a
// variant processor swaps or REMOVES: everything that turns text into itx
// scripts and script results back into conversation. Slash commands (user
// text → script, no LLM), response parsing (accepted assistant output → one
// script via the injected AgentResponseFormat, or corrective feedback), and
// settlement rendering (script result → developer context that drives the
// next turn, spilling oversized results to the agent's workspace). A
// processor composed WITHOUT this component interprets nothing — that is the
// headless lane userland experiments build on: project code consumes the raw
// assistant output events and appends these same consequences itself.

import type { ProcessEventArgs } from "iterate/processors";
import { inferJsonType } from "../../lib/infer-json-type.ts";
import { previewJson } from "../../lib/truncate-json.ts";
import {
  appendUnlessLostIdempotencyRace,
  type AgentComponent,
  type AgentHost,
  type AgentProcessorDeps,
} from "./agent-host.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";
import type { AgentResponseFormat } from "./agent-response-format.ts";
import { resolveSlashCommand, SLASH_COMMAND_EXECUTION_PREFIX } from "./slash-commands.ts";

export class AgentCodemode implements AgentComponent {
  readonly #host: AgentHost;
  readonly #format: AgentResponseFormat;

  constructor(host: AgentHost, format: AgentResponseFormat) {
    this.#host = host;
    this.#format = format;
  }

  processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    const { event, state, blockProcessorWhile, append } = args;
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
        if (payload.role === "user") {
          const slashCommand = resolveSlashCommand(payload.content);
          if (slashCommand !== null) {
            blockProcessorWhile(() =>
              appendUnlessLostIdempotencyRace(append, [
                {
                  type: "events.iterate.com/capability-host/script-run-requested",
                  payload: {
                    code: slashCommand.code,
                    executionId: `${SLASH_COMMAND_EXECUTION_PREFIX}${event.offset}`,
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
        // executable: a caller may raw-append assistant-role history, and may
        // even supply a numeric llmRequestOffset, without thereby gaining a
        // path to capability execution. Blocked for the same per-event reason
        // as the slash path: this event is delivered once, and both the
        // script request and the corrective feedback would be lost forever
        // with it.
        if (
          payload.role === "assistant" &&
          payload.llmRequestOffset !== undefined &&
          payload.llmRequestOffset === state.openRequest?.requestedAtOffset
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
                    role: "developer",
                    content: outcome.feedback,
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
      case "events.iterate.com/capability-host/script-run-settled": {
        const { executionId, settlement } = event.payload;
        if (
          !executionId.startsWith("agent-output:") &&
          !executionId.startsWith(SLASH_COMMAND_EXECUTION_PREFIX)
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
            historyLimit: state.config.scriptResultHistoryLimit,
            writeWorkspaceFile: this.#host.deps.writeWorkspaceFile,
          });
          if (content === null) return;
          await appendUnlessLostIdempotencyRace(append, [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                role: "developer",
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
  historyLimit: number;
  writeWorkspaceFile: AgentProcessorDeps["writeWorkspaceFile"];
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
          rawTextSpillNotice({ path: spilledPath, shownChars, totalChars: text.length }),
        ].join("\n");
      }
      return renderOversizedJsonResult({
        historyLimit,
        path: spilledPath,
        result: settlement.result,
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
  return `Your script returned:\n${fence}\n${truncateScriptResult(text, historyLimit)}\n\`\`\``;
}

function stringifyScriptResult(result: unknown): string {
  // A returned string renders as itself: JSON.stringify would escape every
  // newline and quote, turning a fetched page or file into one unreadable
  // escaped line the model pays to mentally unescape (seen live: an 8.8KB
  // worker.ts as a single escape-riddled JSON string). Non-strings keep the
  // pretty-printed JSON shape.
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

function truncateScriptResult(text: string, historyLimit: number): string {
  if (text.length <= historyLimit) return text;
  return `${text.slice(0, historyLimit)}\n… truncated (${text.length} chars total; up to ${historyLimit} render inline — return less: slice arrays, pick fields)`;
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
    `The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain TypeScript in your next script, e.g.:`,
    "```ts",
    "async (itx) => {",
    `  const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(input.path)}));`,
    "  // you can now do whatever you see fit with `data`",
    "}",
    "```",
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
  shownChars: number;
  totalChars: number;
}): string {
  return [
    `…truncated: showing the first ${input.shownChars.toLocaleString("en-US")} of ${input.totalChars.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(input.path)} — don't re-fetch; read and filter it with plain TypeScript in your next script, e.g.:`,
    "```ts",
    "async (itx) => {",
    `  const text = await itx.workspace.readFile(${JSON.stringify(input.path)});`,
    `  return text.slice(${input.shownChars}, ${input.shownChars * 4}); // page/regex to return only what you need`,
    "}",
    "```",
  ].join("\n");
}

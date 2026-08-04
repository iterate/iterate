import { Document, Scalar, visit } from "yaml";
import type {
  AgentUiCodeStep,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { formatClockTime } from "~/lib/feed-format.ts";

/**
 * A script result as display YAML (the round Result tabs on os and mobile
 * both render results this way — mobile has its own copy of this fold in
 * apps/mobile/src/components/activity-card.tsx). Multiline strings render as
 * |- blocks, long lines never fold.
 */
export function resultYaml(value: unknown): string {
  const doc = new Document(value);
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && node.value.includes("\n")) {
        node.type = Scalar.BLOCK_LITERAL;
      }
    },
  });
  return doc.toString({ lineWidth: 0 }).trimEnd();
}

/**
 * The round Meta tab's YAML document: the round's stats and the replayed
 * prompt (see ~/components/agent-activity-rounds.tsx). Deliberately the SAME
 * shape as mobile's metaYaml (apps/mobile/src/components/activity-card.tsx) —
 * if you change either, ask whether the other surface should follow. Emitted
 * through the `yaml` package rather than hand-rolled string building: prompt
 * content is arbitrary text, and block-scalar edge cases are the library's
 * problem. Absent fields are omitted, not nulled.
 */
export function buildRoundMetaYaml(
  llm: AgentUiLlmStep | null,
  code: AgentUiCodeStep,
  promptMessages: { role: string; content: string }[] | null,
): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const doc = new Document({
    ...(llm
      ? {
          llm: {
            ...(llm.model ? { model: llm.model } : {}),
            ...(llm.durationMs ? { duration: seconds(llm.durationMs) } : {}),
            ...(llm.inputTokens ? { inputTokens: llm.inputTokens } : {}),
            ...(llm.outputTokens ? { outputTokens: llm.outputTokens } : {}),
            ...(llm.outcome && llm.outcome !== "completed" ? { outcome: llm.outcome } : {}),
            ...(llm.cancelReason ? { cancelReason: llm.cancelReason } : {}),
          },
        }
      : {}),
    code: {
      ...(code.status === "running" ? { status: "running" } : {}),
      ...(code.startedAtMs ? { started: formatClockTime(code.startedAtMs) } : {}),
      ...(code.durationMs ? { duration: seconds(code.durationMs) } : {}),
      ...(code.status === "done" && code.success === false ? { failed: true } : {}),
    },
    ...(promptMessages && promptMessages.length > 0
      ? {
          prompt: promptMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }
      : {}),
  });
  visit(doc, {
    // Multiline strings as |- blocks: readable and highlightable, instead of
    // the default quoted-with-\n form.
    Scalar(_key, node) {
      if (typeof node.value === "string" && node.value.includes("\n")) {
        node.type = Scalar.BLOCK_LITERAL;
      }
    },
    // The message/char tally rides as an inline comment on the prompt key.
    Pair(_key, pair) {
      if (promptMessages && pair.key instanceof Scalar && pair.key.value === "prompt") {
        const chars = promptMessages.reduce((sum, message) => sum + message.content.length, 0);
        pair.key.comment = ` ${promptMessages.length} messages, ${chars} chars`;
      }
    },
  });
  // lineWidth 0: never fold long lines — prompt text renders as written.
  return doc.toString({ lineWidth: 0 }).trimEnd();
}

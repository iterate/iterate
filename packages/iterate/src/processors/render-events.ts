import { z } from "zod";

// The RENDER DELTA VOCABULARY: ephemeral live-window facts emitted by a
// derivation processor (project space — the same code that executes a
// response format such as <codemode>) while a model response is still
// streaming, so renderers can show prose as a message and script text as a
// script WITHOUT parsing any format themselves.
//
// The durable half of the render story deliberately has NO new event types:
// the platform's existing vocabulary already carries it —
// `agents/web-message-sent` IS the assistant-message fact,
// `capability-host/script-run-requested` / `-settled` ARE the script facts,
// `agent/summary-updated` the live label — and a derivation processor stamps
// each of those with the top-level `source: { offset }` envelope field (see
// schemas.ts) pointing at the raw assistant event it derived them from.
// Renderers show derived facts and fall back to rendering a raw event only
// when nothing sources it, which is also how threads predating a project's
// derivation processor keep rendering.
//
// These delta types are ephemeral (memory-only, never delivered durably) and
// anchor on the llm request offset because the raw assistant event does not
// exist yet mid-stream. Nothing durable may depend on them: the durable
// facts above land at settlement and are the truth. Deltas are CUMULATIVE —
// each replaces the previous one for its request, so a dropped frame costs
// latency, never content.

export const RENDER_MESSAGE_DELTA = "events.iterate.com/render/message-delta";
export const RENDER_SCRIPT_DELTA = "events.iterate.com/render/script-delta";

export const RenderMessageDelta = z.strictObject({
  llmRequestOffset: z.number().int().nonnegative(),
  /** Prose streamed so far, cumulative — tag syntax already stripped. */
  text: z.string(),
});

export const RenderScriptDelta = z.strictObject({
  llmRequestOffset: z.number().int().nonnegative(),
  /** Script body streamed so far, cumulative. */
  code: z.string(),
  /** The format's live activity label, once its opening tag has streamed. */
  status: z.string().optional(),
});

/**
 * Event definitions in `defineProcessorContract` shape, for a derivation
 * processor to spread into its `events` catalog. Renderer-side consumers
 * (packages/ui) mirror the type strings structurally, as they do for agent
 * events.
 */
export const renderEventDefinitions = {
  [RENDER_MESSAGE_DELTA]: {
    description:
      "Ephemeral live-window prose: the streamed assistant message so far (cumulative, format syntax stripped). Durable truth is the derivation processor's agents/web-message-sent at settlement.",
    payloadSchema: RenderMessageDelta,
    ephemeral: true as const,
  },
  [RENDER_SCRIPT_DELTA]: {
    description:
      "Ephemeral live-window script: the streamed script body (and status) so far, cumulative. Durable truth is the derivation processor's capability-host/script-run-requested at settlement.",
    payloadSchema: RenderScriptDelta,
    ephemeral: true as const,
  },
};

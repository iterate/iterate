import { z } from "zod";

// The RENDER VOCABULARY: derived facts that ARE the feed. A derivation
// processor (project space — the same code that executes a response format
// such as <codemode>) parses raw model output and appends these; renderers
// fold ONLY this vocabulary and never parse any format. A raw assistant
// `agents/context-added` renders solely as fallback when no render fact
// carries `source: { offset }` pointing at it, which is also how threads
// predating a project's derivation processor keep rendering.
//
// Every durable render fact points at its raw input through the top-level
// `source.offset` envelope field (see schemas.ts) — feeds sort by
// `source.offset ?? offset` so late re-derivation of old history lands in
// place. Payloads stay LIGHT: prose text is copied (small, and it makes the
// vocabulary self-sufficient — a feed renderer never fetches raw events),
// but script bodies, results, and prompts are NOT — detail views dereference
// the raw event at `source.offset`.
//
// The ephemeral delta types cover only the live window (a turn currently
// streaming): they anchor on the llm request offset because the raw
// assistant event does not exist yet, and nothing durable may depend on
// them — the durable facts above land at settlement and are the truth.

export const RENDER_MESSAGE_SAID = "events.iterate.com/render/message-said";
export const RENDER_SCRIPT_REQUESTED = "events.iterate.com/render/script-requested";
export const RENDER_SCRIPT_SETTLED = "events.iterate.com/render/script-settled";
export const RENDER_MESSAGE_DELTA = "events.iterate.com/render/message-delta";
export const RENDER_SCRIPT_DELTA = "events.iterate.com/render/script-delta";

export const RenderMessageSaid = z.strictObject({
  /** The message text, verbatim markdown. Copied from the raw event (the one
   * payload in this vocabulary that duplicates raw content — deliberately:
   * prose is small and feed renderers should not need raw events at all). */
  text: z.string().min(1),
});

export const RenderScriptRequested = z.strictObject({
  /** The format's live activity label (`<codemode status="…">`). */
  status: z.string().optional(),
  /** Language of the script body for syntax highlighting. */
  language: z.string(),
  /** Identity shared with the execution request, so the settled fact and the
   * capability host's own events correlate without string parsing. */
  executionId: z.string(),
  // The script body is NOT here: the Script tab reads the raw event at
  // `source.offset`.
});

export const RenderScriptSettled = z.strictObject({
  executionId: z.string(),
  ok: z.boolean(),
  /** Derived from the requested/settled events' journaled createdAt —
   * deterministic across redeliveries, never wall clock. */
  durationMs: z.number().int().nonnegative().optional(),
  // The result body is NOT here: the Result tab reads the raw
  // `capability-host/script-run-settled` event at `source.offset`.
});

/** Ephemeral: prose text streamed so far for the in-flight turn. Cumulative,
 * not a diff — each delta replaces the previous one, so a dropped frame
 * costs latency, never content. */
export const RenderMessageDelta = z.strictObject({
  llmRequestOffset: z.number().int().nonnegative(),
  text: z.string(),
});

/** Ephemeral: script body (and status, once its opening tag has streamed)
 * for the in-flight turn. Cumulative like message-delta. */
export const RenderScriptDelta = z.strictObject({
  llmRequestOffset: z.number().int().nonnegative(),
  code: z.string(),
  status: z.string().optional(),
});

/**
 * Event definitions in `defineProcessorContract` shape, for a derivation
 * processor to spread into its `events` catalog. Renderer-side consumers
 * (packages/ui) mirror the type strings structurally, as they do for agent
 * events.
 */
export const renderEventDefinitions = {
  [RENDER_MESSAGE_SAID]: {
    description:
      "The feed event for an assistant chat message, derived from raw model output by the project's derivation processor. `source.offset` points at the raw event.",
    payloadSchema: RenderMessageSaid,
  },
  [RENDER_SCRIPT_REQUESTED]: {
    description:
      "The feed event for a script card: an assistant turn requested a script run. Light index fact — the script body lives in the raw event at `source.offset`.",
    payloadSchema: RenderScriptRequested,
  },
  [RENDER_SCRIPT_SETTLED]: {
    description:
      "A script card's terminal update. Light index fact — the result body lives in the raw settlement event at `source.offset`.",
    payloadSchema: RenderScriptSettled,
  },
  [RENDER_MESSAGE_DELTA]: {
    description:
      "Ephemeral live-window prose: the streamed message text so far, cumulative. Durable truth is render/message-said at settlement.",
    payloadSchema: RenderMessageDelta,
    ephemeral: true as const,
  },
  [RENDER_SCRIPT_DELTA]: {
    description:
      "Ephemeral live-window script: the streamed script body (and status) so far, cumulative. Durable truth is render/script-requested at settlement.",
    payloadSchema: RenderScriptDelta,
    ephemeral: true as const,
  },
};

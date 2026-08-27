// =============================================================================
// intercepted/* models: definitions shared by both LLM egress paths.
// =============================================================================
// `intercepted/<name>` models are never dialed to a real provider. They are served by
// a LIVE interceptor — a function installed via `itx.ai.intercept(handler)`,
// typically living in a test process and reached back over its capnweb
// connection. The namespace behaves identically in every environment: there is no
// gate, no config, and no credential, and an intercepted/* call with no interceptor
// installed fails loudly. The interception is scoped to this namespace on
// purpose — a turn whose journal says `openai/*` can never have been served by
// a handler.

import { z } from "zod";

/** The model-name namespace served by the live AI interceptor. */
const INTERCEPTED_MODEL_PREFIX = "intercepted/";

/**
 * The root-scope capability path serving intercepted/* models. `ai.intercept`
 * is sugar for mounting the handler as a LIVE capability here; both egress
 * paths consult it through the root capability host. Provide-at-same-path
 * replaces, which is what makes intercept() last-writer-wins.
 */
export const AI_INTERCEPTOR_CAPABILITY_NAME = "aiInterceptor";

export function isInterceptedModel(model: string): boolean {
  return model.startsWith(INTERCEPTED_MODEL_PREFIX);
}

/**
 * One intercepted/* invocation as the interceptor sees it. `source` discriminates the
 * two egress paths: an agent conversation turn carries the provider-neutral
 * chat projection, a direct `itx.ai.run` call carries the caller's body
 * argument verbatim (honestly `unknown` — the caller chose its shape).
 */
export type ProjectAiInterceptorInput =
  | {
      source: "agent-turn";
      model: string;
      body: {
        messages: { role: "system" | "developer" | "user" | "assistant"; content: string }[];
      };
    }
  | {
      source: "ai-run";
      model: string;
      body: unknown;
    };

/**
 * Live replacement for intercepted/* model calls. For `source: "agent-turn"` the
 * return value must be assistant text — a plain string, or
 * `{ text, usage? }` to also report token usage (report inflated numbers to
 * drive compaction deterministically). For `source: "ai-run"` the return value
 * is handed back to the `itx.ai.run` caller verbatim.
 */
export type ProjectAiInterceptor = (input: ProjectAiInterceptorInput) => Promise<unknown>;

/** Disposable handle for one live AI interception. */
export interface ProjectAiIntercept extends Disposable {
  release(): Promise<void>;
}

/** An agent-turn handler's return value, validated at the trust boundary: the
 * handler is arbitrary caller code, and its usage numbers feed journaled
 * token-usage events and the compaction trigger, so nothing crosses uncast
 * and unchecked. */
const InterceptedTurn = z.union([
  z.string().transform((text) => ({ text, usage: undefined })),
  z.object({
    text: z.string(),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cachedInputTokens: z.number().optional(),
        reasoningOutputTokens: z.number().optional(),
      })
      .optional(),
  }),
]);

/** What an agent-turn attempt needs back from the interceptor. */
type InterceptedTurnResult = {
  text: string;
  usage: NonNullable<z.infer<typeof InterceptedTurn>["usage"]>;
};

/**
 * Validate an interceptor's agent-turn return value into the attempt shape. A
 * handler that only cares about text returns a string; omitted usage gets a
 * deterministic text-length estimate (~4 chars/token) so token-usage events
 * and the compaction trigger stay plausible without the handler's help. A
 * malformed result fails the attempt loudly — a handler bug should read as a
 * recorded error, never as garbage token numbers in the journal.
 */
export function normalizeInterceptedTurnResult(input: {
  result: unknown;
  model: string;
  inputCharacters: number;
}): InterceptedTurnResult {
  const { result, model } = input;
  const parsed = InterceptedTurn.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `AI interceptor returned an invalid agent-turn result for "${model}": expected a string or { text, usage? }, got ${JSON.stringify(result)?.slice(0, 200)}`,
    );
  }
  const estimate = (characters: number) => Math.ceil(characters / 4);
  return {
    text: parsed.data.text,
    usage: parsed.data.usage || {
      inputTokens: estimate(input.inputCharacters),
      outputTokens: estimate(parsed.data.text.length),
    },
  };
}

/** The error every path raises when an intercepted/* model has no live interceptor. */
export function noAiInterceptorError(model: string): Error {
  return new Error(
    `No AI interceptor installed for "${model}". Models under "${INTERCEPTED_MODEL_PREFIX}" are served by a live handler: itx.ai.intercept(handler). The handler died with its session, or was never installed.`,
  );
}

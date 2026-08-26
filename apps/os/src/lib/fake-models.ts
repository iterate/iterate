// =============================================================================
// The fake/* model lane: definitions shared by both LLM egress paths.
// =============================================================================
// `fake/<name>` models are never dialed to a real provider. They are served by
// a LIVE interceptor — a function installed via `itx.ai.intercept(handler)`,
// typically living in a test process and reached back over its capnweb
// connection. The lane exists identically in every environment: there is no
// gate, no config, and no credential, and a fake/* call with no interceptor
// installed fails loudly. The interception is scoped to this namespace on
// purpose — a turn whose journal says `openai/*` can never have been served by
// a handler.

/** The model-name namespace served by the live AI interceptor. */
export const FAKE_MODEL_PREFIX = "fake/";

export function isFakeModel(model: string): boolean {
  return model.startsWith(FAKE_MODEL_PREFIX);
}

/**
 * One fake/* invocation as the interceptor sees it. `source` discriminates the
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
 * Live replacement for fake/* model calls. For `source: "agent-turn"` the
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

/** What an agent-turn attempt needs back from the interceptor. */
export type FakeModelTurnResult = {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
};

/**
 * Coerce an interceptor's agent-turn return value into the attempt shape. A
 * handler that only cares about text returns a string; omitted usage gets a
 * deterministic text-length estimate (~4 chars/token) so token-usage events
 * and the compaction trigger stay plausible without the handler's help.
 */
export function normalizeFakeModelTurnResult(input: {
  result: unknown;
  model: string;
  inputCharacters: number;
}): FakeModelTurnResult {
  const { result, model } = input;
  const asObject =
    typeof result === "string"
      ? { text: result }
      : ((result || {}) as { text?: unknown; usage?: unknown });
  if (typeof asObject.text !== "string") {
    throw new Error(
      `AI interceptor returned a non-text agent-turn result for "${model}": expected a string or { text, usage? }, got ${JSON.stringify(result)?.slice(0, 200)}`,
    );
  }
  const estimate = (characters: number) => Math.ceil(characters / 4);
  const usage = asObject.usage as FakeModelTurnResult["usage"] | undefined;
  return {
    text: asObject.text,
    usage: usage || {
      inputTokens: estimate(input.inputCharacters),
      outputTokens: estimate(asObject.text.length),
    },
  };
}

/** The error every path raises when a fake/* model has no live interceptor. */
export function noAiInterceptorError(model: string): Error {
  return new Error(
    `No AI interceptor installed for "${model}". Models under "${FAKE_MODEL_PREFIX}" are served by a live handler: itx.ai.intercept(handler). The handler died with its session, or was never installed.`,
  );
}

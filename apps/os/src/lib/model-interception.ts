// =============================================================================
// intercepted/* models: the provider-dispatch replacement contract.
// =============================================================================
// `intercepted/*` models are never dialed to a real provider. They are served by
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
 * is sugar for mounting the handler as a LIVE capability here; request dispatch
 * consults it through the root capability host. Provide-at-same-path
 * replaces, which is what makes intercept() last-writer-wins.
 */
export const AI_INTERCEPTOR_CAPABILITY_NAME = "aiInterceptor";

export function isInterceptedModel(model: string): boolean {
  return model.startsWith(INTERCEPTED_MODEL_PREFIX);
}

/** Serializable provider response, consumed by the same decoder as a real call. */
export const InterceptedAiResponse = z.object({
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

/** Serialized provider response consumed by the normal response decoder. */
export type InterceptedAiResponse = z.infer<typeof InterceptedAiResponse>;

/** The prepared request, before credentials are attached or a provider is dialed. */
export type ProjectAiInterceptorInput = {
  model: string;
  request: {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    gatewayId: string;
    metadata: Record<string, string | number>;
  };
} & ({ source: "agent-turn"; agentPath: string } | { source: "ai-run" } | { source: "egress" });

/** Replace only the provider call; response classification and decoding still run. */
export type ProjectAiInterceptor = (
  input: ProjectAiInterceptorInput,
) => Promise<InterceptedAiResponse>;

/** Disposable handle for one live AI interception. */
export interface ProjectAiIntercept extends Disposable {
  release(): Promise<void>;
}

/** The error every path raises when an intercepted/* model has no live interceptor. */
export function noAiInterceptorError(model: string): Error {
  return new Error(
    `No AI interceptor installed for "${model}". Models under "${INTERCEPTED_MODEL_PREFIX}" are served by a live handler: itx.ai.intercept(handler). The handler died with its session, or was never installed.`,
  );
}

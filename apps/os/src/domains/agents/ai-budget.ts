import { z } from "zod";

/** A provider has refused a paid request because a configured spending limit is exhausted. */
export const AiBudgetStop = z.object({
  status: z.literal("budget-exhausted"),
  budget: z.object({
    provider: z.string(),
    ruleId: z.string().nullable(),
    resetsAt: z.string().nullable(),
  }),
});
/** A confirmed spending-limit refusal, with provider evidence for the pause UI. */
export type AiBudgetStop = z.infer<typeof AiBudgetStop>;

const CloudflareBudgetResponse = z.object({
  name: z.literal("AiGatewayError"),
  internalCode: z.literal(2041),
  message: z.string(),
});
// https://help.openai.com/en/articles/6614457 — error.code, not the broad insufficient_quota type.
const OpenAiBudgetResponse = z.object({
  error: z.object({
    code: z.enum(["organization_spend_limit_exceeded", "project_spend_limit_exceeded"]),
  }),
});

/** CF's 2041 is captured in fixtures/cloudflare-budget-exceeded.json. A generic 429 is not a budget stop. */
export async function readAiBudgetStop(
  response: Response,
  provider: string,
): Promise<AiBudgetStop | null> {
  if (response.status !== 429) return null;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const cf = CloudflareBudgetResponse.safeParse(body);
  if (cf.success) {
    return {
      status: "budget-exhausted",
      budget: {
        provider,
        // The error code is authoritative; this optional label is presentation only.
        ruleId: cf.data.message.match(/Spend limit exceeded: rule '([^']+)'/)?.[1] || null,
        resetsAt: null,
      },
    };
  }
  if (OpenAiBudgetResponse.safeParse(body).success) {
    return { status: "budget-exhausted", budget: { provider, ruleId: null, resetsAt: null } };
  }
  return null;
}

/** A temporary provider rate limit; retried only by the agent's bounded retry policy. */
export const AiRateLimitStop = z.object({
  status: z.literal("rate-limited"),
  retryAfterMs: z.number().nonnegative().max(60_000),
});
/** A temporary rate refusal whose delay is bounded before journal persistence. */
export type AiRateLimitStop = z.infer<typeof AiRateLimitStop>;

/** Bound Retry-After before persisting it; malformed or absent values use policy backoff. */
export function readAiRateLimitStop(response: Response): AiRateLimitStop | null {
  if (response.status !== 429) return null;
  const retryAfter = response.headers.get("retry-after");
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter || "") - Date.now();
  return {
    status: "rate-limited",
    retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(60_000, delay)) : 0,
  };
}

/** Expected refusal of an AI call: a spending pause or a bounded temporary rate limit. */
export type AiCallStop = AiBudgetStop | AiRateLimitStop;

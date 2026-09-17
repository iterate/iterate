import { z } from "zod";
import { isInterceptedModel } from "./model-interception.ts";

/** Immutable project opt-in: model selection happens before requests are journaled. */
export const ProjectAiPolicy = z.object({
  liveAgentPaths: z.array(z.string().startsWith("/agents/")).default([]),
});

/** Project-wide intercepted model selection, except the listed exact agent paths. */
export type ProjectAiPolicy = z.output<typeof ProjectAiPolicy>;

export function projectAiModel(
  model: string,
  policy: ProjectAiPolicy | undefined,
  agentPath: string | undefined,
): string {
  if (!policy || isInterceptedModel(model)) return model;
  if (agentPath && policy.liveAgentPaths.includes(agentPath)) return model;
  return `intercepted/${model}`;
}

/** Explicit fixture identity or slug; mobile OAuth tokens may omit the login email. */
export function signupTestAiPolicy(
  email: string | undefined,
  slug: string,
  environmentName: string | undefined,
): ProjectAiPolicy | undefined {
  if (environmentName === "prd") return undefined;
  const testIdentity = email?.startsWith("intercepted-e2e-") && email.endsWith("+test@nustom.com");
  return testIdentity || slug.startsWith("intercepted-e2e-") ? { liveAgentPaths: [] } : undefined;
}

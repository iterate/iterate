import { z } from "zod";
import { isInterceptedModel } from "./model-interception.ts";

/** Immutable project opt-in: model selection happens before requests are journaled. */
export const ProjectAiPolicy = z.object({
  liveAgentPaths: z.array(z.string().startsWith("/agents/")).default([]),
});

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

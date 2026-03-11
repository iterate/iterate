import { z } from "zod/v4";

export const PromptAddedEvent = z.object({
  type: z.literal("iterate:agent:prompt-added"),
  message: z.string(),
});

export const AgentUpdatedEvent = z.object({
  type: z.literal("iterate:agent:updated"),
  path: z.string(),
  isWorking: z.boolean().optional(),
  shortStatus: z.string().max(30).optional(),
});

export const IterateEvent = z.discriminatedUnion("type", [PromptAddedEvent, AgentUpdatedEvent]);

export type PromptAddedEvent = z.infer<typeof PromptAddedEvent>;
export type AgentUpdatedEvent = z.infer<typeof AgentUpdatedEvent>;
export type IterateEvent = z.infer<typeof IterateEvent>;

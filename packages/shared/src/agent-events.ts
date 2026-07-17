import { z } from "zod";

export const AgentLlmRequestCancelReason = z.enum([
  "interrupted-by-user-input",
  "durable-object-crashed",
]);
export type AgentLlmRequestCancelReason = z.infer<typeof AgentLlmRequestCancelReason>;

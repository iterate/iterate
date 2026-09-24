import { z } from "zod";

export const AgentLlmRequestCancelReason = z.enum(["interrupted-by-user-input", "expired"]);
export type AgentLlmRequestCancelReason = z.infer<typeof AgentLlmRequestCancelReason>;

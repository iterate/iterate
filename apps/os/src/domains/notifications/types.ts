import { z } from "zod";

export const NotificationDestination = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({
    kind: z.literal("approvals"),
    approvalRequestEventOffset: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal("agent-chat"), path: z.string().startsWith("/agents/") }),
]);

export const NotificationRequest = z.strictObject({
  audience: z.strictObject({ kind: z.literal("project") }),
  body: z.string().trim().min(1).max(4_000),
  destination: NotificationDestination,
  expiresAt: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
});

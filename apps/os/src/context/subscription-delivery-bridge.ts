import { codedError } from "iterate/lib";
import { z } from "zod";

/** A platform facet's request to deliver one source-page range of its configured subscription. */
export const SubscriptionDeliveryBridgeRequest = z.strictObject({
  name: z.string().min(1).max(200),
  configuredAtOffset: z.number().int().positive(),
  range: z.strictObject({
    after: z.number().int().nonnegative(),
    through: z.number().int().nonnegative(),
  }),
});

export type SubscriptionDeliveryBridgeRequest = z.infer<typeof SubscriptionDeliveryBridgeRequest>;

/** The same private identity, recording the bounded runner's terminal state atomically at its row. */
export const SubscriptionDeliveryTerminalRequest = z.strictObject({
  name: z.string().min(1).max(200),
  configuredAtOffset: z.number().int().positive(),
  afterOffset: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  error: z.string().max(1024),
  fanOut: z.literal(true).optional(),
  resumeAtOffset: z.number().int().positive().optional(),
});
export type SubscriptionDeliveryTerminalRequest = z.infer<
  typeof SubscriptionDeliveryTerminalRequest
>;

/** Parse the private RPC boundary without leaking a Zod implementation error across Workers RPC. */
export function parseSubscriptionDeliveryBridgeRequest(
  input: unknown,
): SubscriptionDeliveryBridgeRequest {
  const parsed = SubscriptionDeliveryBridgeRequest.safeParse(input);
  if (!parsed.success)
    throw codedError("INVALID_INPUT", "configured subscription delivery request is invalid");
  return parsed.data;
}

export function parseSubscriptionDeliveryTerminalRequest(
  input: unknown,
): SubscriptionDeliveryTerminalRequest {
  const parsed = SubscriptionDeliveryTerminalRequest.safeParse(input);
  if (!parsed.success)
    throw codedError("INVALID_INPUT", "configured subscription terminal request is invalid");
  return parsed.data;
}

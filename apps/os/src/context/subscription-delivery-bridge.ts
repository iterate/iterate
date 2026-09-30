import { codedError } from "iterate/lib";
import { z } from "zod";

const SubscriptionDeliveryIdentity = z.strictObject({
  name: z.string().min(1).max(200),
  configuredAtOffset: z.number().int().positive(),
  resumeAtOffset: z.number().int().positive().optional(),
});

/** A platform facet's metadata read. Bodies never leave the context Durable Object. */
export const SubscriptionDeliveryReadPageRequest = SubscriptionDeliveryIdentity.extend({
  afterOffset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(1_000),
});
export type SubscriptionDeliveryReadPageRequest = z.infer<
  typeof SubscriptionDeliveryReadPageRequest
>;

/** A platform facet's durable source proof. Bodies never leave the context Durable Object. */
export const SubscriptionDeliveryBridgeRequest = SubscriptionDeliveryIdentity.extend({
  range: z.strictObject({
    after: z.number().int().nonnegative(),
    through: z.number().int().nonnegative(),
  }),
  offsets: z.array(z.number().int().positive()).max(1_000),
});
export type SubscriptionDeliveryBridgeRequest = z.infer<typeof SubscriptionDeliveryBridgeRequest>;

/** One ephemeral body is a separate, non-replayable private handoff from the live ring. */
export const SubscriptionDeliveryEphemeralRequest = SubscriptionDeliveryIdentity.extend({
  event: z
    .object({
      offset: z.number().int().positive(),
      path: z.string(),
      ephemeral: z.literal(true),
    })
    .passthrough(),
});
export type SubscriptionDeliveryEphemeralRequest = z.infer<
  typeof SubscriptionDeliveryEphemeralRequest
>;

/** The same private identity, recording the bounded runner's terminal state atomically at its row. */
export const SubscriptionDeliveryTerminalRequest = SubscriptionDeliveryIdentity.extend({
  afterOffset: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  error: z.string().max(1024),
  fanOut: z.literal(true).optional(),
});
export type SubscriptionDeliveryTerminalRequest = z.infer<
  typeof SubscriptionDeliveryTerminalRequest
>;

/** Parse the private RPC boundary without leaking a Zod implementation error across Workers RPC. */
export function parseSubscriptionDeliveryReadRequest(
  input: unknown,
): SubscriptionDeliveryReadPageRequest {
  const parsed = SubscriptionDeliveryReadPageRequest.safeParse(input);
  if (!parsed.success)
    throw codedError("INVALID_INPUT", "configured subscription read request is invalid");
  return parsed.data;
}

export function parseSubscriptionDeliveryBridgeRequest(
  input: unknown,
): SubscriptionDeliveryBridgeRequest {
  const parsed = SubscriptionDeliveryBridgeRequest.safeParse(input);
  if (!parsed.success)
    throw codedError("INVALID_INPUT", "configured subscription delivery request is invalid");
  return parsed.data;
}

export function parseSubscriptionDeliveryEphemeralRequest(
  input: unknown,
): SubscriptionDeliveryEphemeralRequest {
  const parsed = SubscriptionDeliveryEphemeralRequest.safeParse(input);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      "configured ephemeral subscription delivery request is invalid",
    );
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

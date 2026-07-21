import { z } from "zod";

/** Host-minted explanation of which runtime invocation reached project egress. */
export const EgressInvocationSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("script-execution"),
    streamPath: z.string().trim().startsWith("/"),
    scriptRunRequestedEventOffset: z.number().int().nonnegative(),
    executionId: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("scope"),
    scopePath: z.string().trim().startsWith("/"),
  }),
]);

export type EgressInvocationSource = z.output<typeof EgressInvocationSource>;

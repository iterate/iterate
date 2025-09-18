import * as R from "remeda";
import { z } from "zod";

const EventLike = z.looseObject({ type: z.string() });

export const MagicAgentInstructions = z.object({
  __addAgentCoreEvents: z.array(z.lazy(() => EventLike)).optional(), // Careful - we use this for non-agent core events too!
  __pauseAgentUntilMentioned: z.boolean().optional(),
  __triggerLLMRequest: z.boolean().optional(),
});
export type MagicAgentInstructions = z.infer<typeof MagicAgentInstructions>;

export const parseMagicAgentInstructions = <T>(
  result: T,
): { magic: MagicAgentInstructions; cleanedResult: T } => {
  const parsed = MagicAgentInstructions.safeParse(result);
  if (!parsed.success) {
    return { magic: {}, cleanedResult: result };
  }

  const cleanedResult = R.omitBy(result as {}, (_v, k) => k in MagicAgentInstructions.shape);
  return { magic: parsed.data, cleanedResult: cleanedResult as T };
};

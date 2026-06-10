import { z } from "zod";
import { JSONObject, StreamPath } from "@iterate-com/shared/streams/types";

export const StreamNavigationState = z.object({
  namespace: z.string().trim().min(1),
  path: StreamPath,
  eventCount: z.number().int().nonnegative(),
  childPaths: z.array(StreamPath),
  metadata: JSONObject,
});
export type StreamNavigationState = z.infer<typeof StreamNavigationState>;

export function parseStreamNavigationState(input: unknown) {
  return StreamNavigationState.parse(input);
}

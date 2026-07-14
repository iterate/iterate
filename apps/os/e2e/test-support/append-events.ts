import type { Stream, StreamEvent, StreamEventInput } from "../../src/itx-api.generated.ts";

/** Request committed envelopes explicitly in tests that need assigned offsets. */
export async function appendEvents(
  stream: Pick<Stream, "append">,
  ...events: StreamEventInput[]
): Promise<StreamEvent[]> {
  const result = await stream.append({ return: "events" }, ...events);
  if (!Array.isArray(result) || result.some((value) => typeof value !== "object")) {
    throw new Error("append did not return events");
  }
  return result as StreamEvent[];
}

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

/** Request assigned offsets explicitly in tests that do not need full envelopes. */
export async function appendOffsets(
  stream: Pick<Stream, "append">,
  ...events: StreamEventInput[]
): Promise<number[]> {
  const result = await stream.append({ return: "offsets" }, ...events);
  if (!Array.isArray(result) || result.some((value) => typeof value !== "number")) {
    throw new Error("append did not return offsets");
  }
  return result as number[];
}

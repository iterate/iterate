import { z } from "zod";

/** Host-minted context for the durable stream invocation currently executing. */
export const StreamContext = z.discriminatedUnion("kind", [
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

export type StreamContext = z.output<typeof StreamContext>;

/** Private request carrier used only between trusted fetch-native OS hops. */
export const STREAM_CONTEXT_HEADER = "x-iterate-internal-stream-context";

/** Stamp trusted context onto a fetch-native request, replacing any caller value. */
export function withStreamContext(request: Request, streamContext: StreamContext): Request {
  const headers = new Headers(request.headers);
  headers.set(STREAM_CONTEXT_HEADER, JSON.stringify(StreamContext.parse(streamContext)));
  return new Request(request, { headers });
}

/** Remove and validate trusted context before the request reaches policy or egress code. */
export function takeStreamContext(request: Request): {
  request: Request;
  streamContext: StreamContext;
} {
  const headers = new Headers(request.headers);
  const encoded = headers.get(STREAM_CONTEXT_HEADER);
  headers.delete(STREAM_CONTEXT_HEADER);
  return {
    request: new Request(request, { headers }),
    streamContext:
      encoded === null
        ? { kind: "scope", scopePath: "/" }
        : StreamContext.parse(JSON.parse(encoded)),
  };
}

import { expect, test } from "vitest";
import { STREAM_CONTEXT_HEADER, takeStreamContext, withStreamContext } from "./stream-context.ts";

test("a trusted fetch hop overwrites caller context and the receiver strips it", () => {
  const forged = new Request("https://payments.example/refund", {
    headers: {
      [STREAM_CONTEXT_HEADER]: JSON.stringify({
        kind: "script-execution",
        streamPath: "/agents/forged",
        scriptRunRequestedEventOffset: 999,
        executionId: "forged",
      }),
    },
  });
  const stamped = withStreamContext(forged, {
    kind: "script-execution",
    streamPath: "/agents/refunds",
    scriptRunRequestedEventOffset: 42,
    executionId: "refund-42",
  });

  const taken = takeStreamContext(stamped);

  expect(taken.streamContext).toEqual({
    kind: "script-execution",
    streamPath: "/agents/refunds",
    scriptRunRequestedEventOffset: 42,
    executionId: "refund-42",
  });
  expect(taken.request.headers.has(STREAM_CONTEXT_HEADER)).toBe(false);
});

test("an unstamped fetch uses the project root stream context", () => {
  expect(takeStreamContext(new Request("https://payments.example/refund"))).toMatchObject({
    streamContext: { kind: "scope", scopePath: "/" },
  });
});

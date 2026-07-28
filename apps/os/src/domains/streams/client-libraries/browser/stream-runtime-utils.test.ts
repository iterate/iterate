import { describe, expect, it } from "vitest";
import { isStreamSessionBrokenError } from "./stream-runtime-utils.ts";

describe("isStreamSessionBrokenError", () => {
  it.each([
    "WebSocket closed before the RPC settled",
    "RPC session disconnected",
    "kill requested",
  ])("classifies transport teardown: %s", (message) => {
    expect(isStreamSessionBrokenError(new Error(message))).toBe(true);
  });

  it("does not retry an application rejection", () => {
    expect(isStreamSessionBrokenError(new Error("stream is paused"))).toBe(false);
  });
});

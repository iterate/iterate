import { describe, expect, it } from "vitest";
import {
  StreamIdMismatchError,
  StreamOffsetConflictError,
  isStreamIdMismatchError,
  isStreamOffsetConflictError,
  streamIdMismatchMessage,
  streamOffsetConflictMessage,
} from "iterate/processors";

describe("isStreamOffsetConflictError", () => {
  it("matches a local typed conflict", () => {
    expect(
      isStreamOffsetConflictError(new StreamOffsetConflictError(streamOffsetConflictMessage(4, 6))),
    ).toBe(true);
  });

  it("matches the plain Error CapnWeb exposes for a remote conflict", () => {
    expect(isStreamOffsetConflictError(new Error(streamOffsetConflictMessage(13, 14)))).toBe(true);
  });

  it("does not retry unrelated plain errors", () => {
    expect(isStreamOffsetConflictError(new Error("expected next offset soon"))).toBe(false);
    expect(isStreamOffsetConflictError({ message: "expected next offset 4, found 6" })).toBe(false);
  });
});

describe("isStreamIdMismatchError", () => {
  const expected = "11111111-1111-4111-8111-111111111111";
  const actual = "22222222-2222-4222-8222-222222222222";

  it("matches local and RPC-normalized guarded-append rejections", () => {
    const message = streamIdMismatchMessage(expected, actual);
    expect(isStreamIdMismatchError(new StreamIdMismatchError(message))).toBe(true);
    expect(isStreamIdMismatchError(new Error(message))).toBe(true);
  });

  it("does not discard recovery for unrelated errors", () => {
    expect(isStreamIdMismatchError(new Error("stream ID changed unexpectedly"))).toBe(false);
    expect(isStreamIdMismatchError({ message: streamIdMismatchMessage(expected, actual) })).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import { StreamOffsetConflictError, isStreamOffsetConflictError } from "./rpc-types.ts";

describe("isStreamOffsetConflictError", () => {
  it("matches a local typed conflict", () => {
    expect(
      isStreamOffsetConflictError(new StreamOffsetConflictError("expected next offset 4, found 6")),
    ).toBe(true);
  });

  it("matches the plain Error CapnWeb exposes for a remote conflict", () => {
    expect(isStreamOffsetConflictError(new Error("expected next offset 13, found 14"))).toBe(true);
  });

  it("does not retry unrelated plain errors", () => {
    expect(isStreamOffsetConflictError(new Error("expected next offset soon"))).toBe(false);
    expect(isStreamOffsetConflictError({ message: "expected next offset 4, found 6" })).toBe(false);
  });
});

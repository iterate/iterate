import { describe, expect, it } from "vitest";
import { idempotencyConflictMessage, isIdempotencyConflict } from "./idempotency.ts";

describe("idempotency conflict contract", () => {
  it("builds the canonical conflict message", () => {
    expect(idempotencyConflictMessage("request-7", 42)).toBe(
      [
        "idempotency",
        "key",
        '"request-7"',
        "already",
        "names",
        "a",
        "different",
        "event",
        "at",
        "offset",
        "42",
      ].join(" "),
    );
  });

  it("recognizes a remotely prefixed conflict without matching unrelated errors", () => {
    const conflict = idempotencyConflictMessage("request-7", 42);
    expect(isIdempotencyConflict(new Error(`remote append failed: ${conflict}`))).toBe(true);
    expect(isIdempotencyConflict(new Error("remote append failed: idempotency collision"))).toBe(
      false,
    );
  });
});

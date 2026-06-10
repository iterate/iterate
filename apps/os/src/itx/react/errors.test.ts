import { describe, expect, test } from "vitest";
import { ItxError, tagOutboundItxError } from "../errors.ts";
import { getItxErrorCode, isItxAccessError } from "./errors.ts";

/**
 * What the far side of a capnweb session holds after an ItxError crosses:
 * a plain reconstructed Error with the thrown error's own enumerable props
 * reattached — class identity gone and `name` DROPPED. (capnweb 0.8.0
 * serializes `["error", name, message, stack?, props?]` with props from
 * `Object.keys(error)` minus name/message/stack, but the receiver only maps
 * builtin names to their classes — an unknown name reconstructs as plain
 * `Error` and is skipped again in the props loop, so it never comes back.)
 */
function simulateCapnwebCrossing(error: Error): Error {
  const received = new Error(error.message);
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    (received as unknown as Record<string, unknown>)[key] = (
      error as unknown as Record<string, unknown>
    )[key];
  }
  return received;
}

describe("ItxError", () => {
  test("code and details are own enumerable properties (the load-bearing wire property)", () => {
    const error = new ItxError({
      code: "NOT_FOUND",
      details: { projectIdOrSlug: "nope" },
      message: "Project nope not found.",
    });
    expect(Object.keys(error)).toContain("code");
    expect(Object.keys(error)).toContain("details");
    expect(error.name).toBe("ItxError");
  });

  test("details stays off the instance (and the wire) when not provided", () => {
    const error = new ItxError({ code: "FORBIDDEN", message: "no" });
    expect(Object.keys(error)).not.toContain("details");
  });

  test("code and details survive a simulated capnweb round trip; instanceof does not", () => {
    const thrown = new ItxError({
      code: "NOT_FOUND",
      details: { projectIdOrSlug: "ghost" },
      message: "Project ghost not found.",
    });
    const received = simulateCapnwebCrossing(thrown);

    expect(received).not.toBeInstanceOf(ItxError);
    expect(getItxErrorCode(received)).toBe("NOT_FOUND");
    expect((received as unknown as { details: unknown }).details).toEqual({
      projectIdOrSlug: "ghost",
    });
  });
});

describe("getItxErrorCode", () => {
  test("reads the code from anything ItxError-shaped", () => {
    expect(getItxErrorCode(new ItxError({ code: "CONFLICT", message: "taken" }))).toBe("CONFLICT");
    // What a capnweb crossing actually leaves behind: plain Error + code,
    // no name. This shape MUST be detected.
    const duckTyped = Object.assign(new Error("rejected"), { code: "FORBIDDEN" });
    expect(getItxErrorCode(duckTyped)).toBe("FORBIDDEN");
  });

  test("returns undefined for everything else", () => {
    expect(getItxErrorCode(new Error("The itx connection was closed."))).toBeUndefined();
    expect(getItxErrorCode(new Error("network timeout"))).toBeUndefined();
    expect(getItxErrorCode("Unauthorized")).toBeUndefined();
    expect(getItxErrorCode(null)).toBeUndefined();
    // A coded error from someone else: code outside the five-code set.
    expect(
      getItxErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
    ).toBeUndefined();
    expect(getItxErrorCode(Object.assign(new Error("x"), { code: "TEAPOT" }))).toBeUndefined();
  });
});

describe("isItxAccessError", () => {
  test("true exactly for NOT_FOUND and FORBIDDEN", () => {
    expect(isItxAccessError(new ItxError({ code: "NOT_FOUND", message: "gone" }))).toBe(true);
    expect(isItxAccessError(new ItxError({ code: "FORBIDDEN", message: "no" }))).toBe(true);
    expect(isItxAccessError(new ItxError({ code: "CONFLICT", message: "taken" }))).toBe(false);
    expect(isItxAccessError(new ItxError({ code: "BAD_REQUEST", message: "bad" }))).toBe(false);
    expect(isItxAccessError(new ItxError({ code: "INTERNAL", message: "boom" }))).toBe(false);
    expect(isItxAccessError(new Error("WebSocket peer disconnected"))).toBe(false);
  });
});

describe("tagOutboundItxError", () => {
  test("returns ItxErrors unchanged (which opts their stack into transmission)", () => {
    const error = new ItxError({ code: "NOT_FOUND", message: "gone" });
    expect(tagOutboundItxError(error)).toBe(error);
  });

  test("rewrites everything else to INTERNAL, preserving message and stack", () => {
    const original = new Error("kaboom");
    const tagged = tagOutboundItxError(original);
    expect(getItxErrorCode(tagged)).toBe("INTERNAL");
    expect(tagged.message).toBe("kaboom");
    expect(tagged.stack).toBe(original.stack);
  });
});

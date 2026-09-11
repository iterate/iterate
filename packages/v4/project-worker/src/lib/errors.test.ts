import { afterEach, expect, test, vi } from "vitest";
import { codedError, isRetryableDurableObjectReset, reportIssue } from "./errors.ts";

afterEach(() => vi.restoreAllMocks());

function reported(error: unknown) {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const issue = vi.spyOn(console, "error").mockImplementation(() => undefined);
  reportIssue("stream.catchUp", error, { context: "prj_test" });
  return { info, issue };
}

test("a retryable non-overloaded Durable Object reset is an expected platform interruption", () => {
  const reset = Object.assign(codedError("TIMEOUT", "Durable Object reset"), {
    retryable: true,
    durableObjectReset: true,
  });
  const { info, issue } = reported(reset);

  expect(isRetryableDurableObjectReset(reset)).toBe(true);
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "expected_platform_interruption",
      outcome: "interrupted",
      failureSite: "stream.catchUp",
      context: "prj_test",
      retryable: true,
      durableObjectReset: true,
      overloaded: undefined,
      code: "TIMEOUT",
      error: expect.objectContaining({ type: "Error", message: "Durable Object reset" }),
    }),
  );
  expect(issue).not.toHaveBeenCalled();
});

test.each([
  ["a message alone", new Error("Durable Object reset")],
  [
    "an overloaded reset",
    Object.assign(new Error("Durable Object reset"), {
      retryable: true,
      durableObjectReset: true,
      overloaded: true,
    }),
  ],
  [
    "a reset with a string overloaded flag",
    Object.assign(new Error("Durable Object reset"), {
      retryable: true,
      durableObjectReset: true,
      overloaded: "no",
    }),
  ],
  [
    "a reset with an object overloaded flag",
    Object.assign(new Error("Durable Object reset"), {
      retryable: true,
      durableObjectReset: true,
      overloaded: { retained: "unbounded" },
    }),
  ],
  [
    "a reset without retryability",
    Object.assign(new Error("Durable Object reset"), { durableObjectReset: true }),
  ],
  [
    "a false reset flag",
    Object.assign(new Error("Durable Object reset"), {
      retryable: true,
      durableObjectReset: false,
    }),
  ],
] as const)("%s remains an unexpected issue", (_case, error) => {
  const { info, issue } = reported(error);

  expect(isRetryableDurableObjectReset(error)).toBe(false);
  expect(info).not.toHaveBeenCalled();
  expect(issue).toHaveBeenCalledWith(expect.objectContaining({ event: "issue" }));
});

test("a changing getter cannot turn an unbounded flag into an info record", () => {
  const changing = new Error("Durable Object reset");
  Object.defineProperties(changing, {
    retryable: { enumerable: true, get: () => true },
    durableObjectReset: { enumerable: true, get: () => true },
    // Before bounded capture, reportIssue read this once to save it and again in the predicate.
    // That allowed an object first and undefined second to be spread into the info payload.
    overloaded: {
      enumerable: true,
      get: vi.fn().mockReturnValueOnce({ retained: "unbounded" }).mockReturnValueOnce(undefined),
    },
  });
  const { info, issue } = reported(changing);

  expect(info).not.toHaveBeenCalled();
  expect(issue).toHaveBeenCalledWith(expect.objectContaining({ event: "issue" }));
});

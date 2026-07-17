import { describe, expect, it } from "vitest";
import {
  isDurableObjectLifecycleError,
  isStreamWaitTimeoutError,
  isStreamUnavailableError,
  rethrowStreamUnavailable,
  STREAM_UNAVAILABLE_MESSAGE_PREFIX,
  STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX,
} from "./stream-unavailable.ts";

const withFlag = (flag: string, value: unknown = true) =>
  Object.assign(new Error("kill requested"), { [flag]: value });

describe("isDurableObjectLifecycleError", () => {
  it.each([
    // The shape ctx.abort() puts on in-flight stub rejections (empirically
    // probed against a dev stream DO: props were exactly
    // [stack, message, durableObjectReset]).
    ["durableObjectReset flag", withFlag("durableObjectReset"), true],
    ["retryable flag", withFlag("retryable"), true],
    ["overloaded flag", withFlag("overloaded"), true],
    [
      "lifecycle flag on a wrapped cause",
      new Error("storage operation failed", { cause: withFlag("durableObjectReset") }),
      true,
    ],
    ["flag present but not literally true", withFlag("retryable", "yes"), false],
    ["plain Error (app-level throw from the DO)", new Error("kill requested"), false],
    ["string rejection", "kill requested", false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("%s → %s", (_name, error, expected) => {
    expect(isDurableObjectLifecycleError(error)).toBe(expected);
  });

  it("terminates safely when an error cause chain is cyclic", () => {
    const first = new Error("first") as Error & { cause?: unknown };
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(isDurableObjectLifecycleError(first)).toBe(false);
  });
});

describe("rethrowStreamUnavailable", () => {
  it("tags DO-lifecycle rejections and keeps the original as cause", () => {
    const original = withFlag("durableObjectReset");
    let caught: unknown;
    try {
      rethrowStreamUnavailable(original);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}kill requested`);
    expect((caught as Error).cause).toBe(original);
    expect(isStreamUnavailableError(caught)).toBe(true);
  });

  it("rethrows app-level rejections untouched (identity, not a copy)", () => {
    const appError = new Error("waitForEvent requires eventTypes or predicate.");
    let caught: unknown;
    try {
      rethrowStreamUnavailable(appError);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(appError);
    expect(isStreamUnavailableError(caught)).toBe(false);
  });
});

describe("isStreamUnavailableError", () => {
  it.each([
    ["tagged rejection", new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}kill requested`), true],
    [
      "tagged and later wrapped by an outer layer",
      new Error(`script step 3 failed: ${STREAM_UNAVAILABLE_MESSAGE_PREFIX}kill requested`),
      true,
    ],
    ["untagged DO abort reason (the pre-contract wire shape)", new Error("kill requested"), false],
    ["tag text in a non-Error value", `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}kill requested`, false],
    ["unrelated app error", new Error('no capability "itx.streams.get"'), false],
  ])("%s → %s", (_name, error, expected) => {
    expect(isStreamUnavailableError(error)).toBe(expected);
  });
});

describe("isStreamWaitTimeoutError", () => {
  it("classifies only the explicit stream waiter timeout contract", () => {
    expect(
      isStreamWaitTimeoutError(
        new Error(`${STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX}Timed out waiting for stream event`),
      ),
    ).toBe(true);
    expect(isStreamWaitTimeoutError(new Error("predicate failed"))).toBe(false);
    expect(isStreamWaitTimeoutError("stream-wait-timeout: string rejection")).toBe(false);
  });
});

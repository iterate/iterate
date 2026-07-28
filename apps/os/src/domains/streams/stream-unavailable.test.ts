import { describe, expect, it, vi } from "vitest";
import {
  isDurableObjectLifecycleError,
  isRetryableDurableObjectAvailabilityError,
  isStreamWaitTimeoutError,
  isStreamUnavailableError,
  rethrowStreamUnavailable,
  retryIdempotentDurableObjectOperation,
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
    ["flag present but not literally true", withFlag("retryable", "yes"), false],
    ["plain Error (app-level throw from the DO)", new Error("kill requested"), false],
    ["string rejection", "kill requested", false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("%s → %s", (_name, error, expected) => {
    expect(isDurableObjectLifecycleError(error)).toBe(expected);
  });
});

describe("retryIdempotentDurableObjectOperation", () => {
  it("retries one locally wrapped lifecycle failure", async () => {
    const reset = withFlag("durableObjectReset");
    const wrapped = new Error("agent collection could not catch up", { cause: reset });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValueOnce("recovered");
    const onRetry = vi.fn();

    await expect(retryIdempotentDurableObjectOperation({ operation, onRetry })).resolves.toBe(
      "recovered",
    );
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, error: wrapped, maxAttempts: 2 });
  });

  it("recognises the stream wire tag and stops after one retry", async () => {
    const first = new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}code updated`);
    const terminal = withFlag("overloaded");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(terminal);

    await expect(retryIdempotentDurableObjectOperation({ operation })).rejects.toBe(terminal);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(isRetryableDurableObjectAvailabilityError(first)).toBe(true);
  });

  it("never retries an application failure or loops over cyclic causes", async () => {
    const applicationError = new Error("invalid event");
    const operation = vi.fn(async () => {
      throw applicationError;
    });
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    await expect(retryIdempotentDurableObjectOperation({ operation })).rejects.toBe(
      applicationError,
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(isRetryableDurableObjectAvailabilityError(first)).toBe(false);
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

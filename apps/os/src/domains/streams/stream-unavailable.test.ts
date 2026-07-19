import { describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENT_DURABLE_OBJECT_LIFECYCLE_MAX_ATTEMPTS,
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
  it("runs once when the operation succeeds", async () => {
    const operation = vi.fn(async () => "done");
    const onRetry = vi.fn();

    await expect(retryIdempotentDurableObjectOperation({ operation, onRetry })).resolves.toBe(
      "done",
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries lifecycle failures and returns the fresh incarnation's result", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(withFlag("durableObjectReset"))
      .mockRejectedValueOnce(withFlag("overloaded"))
      .mockResolvedValueOnce("recovered");
    const onRetry = vi.fn();

    await expect(retryIdempotentDurableObjectOperation({ operation, onRetry })).resolves.toBe(
      "recovered",
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith({
      attempt: 2,
      error: expect.objectContaining({ overloaded: true }),
      maxAttempts: IDEMPOTENT_DURABLE_OBJECT_LIFECYCLE_MAX_ATTEMPTS,
    });
  });

  it("retries a nested Stream lifecycle failure after RPC strips the workerd flags", async () => {
    const serialized = new Error(
      `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}Durable Object reset because its code was updated.`,
    );
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(serialized)
      .mockResolvedValueOnce("recovered");

    await expect(retryIdempotentDurableObjectOperation({ operation })).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(isDurableObjectLifecycleError(serialized)).toBe(false);
    expect(isRetryableDurableObjectAvailabilityError(serialized)).toBe(true);
  });

  it("retries a locally wrapped lifecycle failure through its cause chain", async () => {
    const reset = withFlag("durableObjectReset");
    const wrapped = new Error("agent collection could not catch up", { cause: reset });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValueOnce("recovered");

    await expect(retryIdempotentDurableObjectOperation({ operation })).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(isDurableObjectLifecycleError(wrapped)).toBe(false);
    expect(isRetryableDurableObjectAvailabilityError(wrapped)).toBe(true);
  });

  it("does not loop forever on a cyclic cause chain", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(isRetryableDurableObjectAvailabilityError(first)).toBe(false);
  });

  it("never retries an application error", async () => {
    const applicationError = new Error("invalid workspace mount");
    const operation = vi.fn(async () => {
      throw applicationError;
    });

    await expect(retryIdempotentDurableObjectOperation({ operation })).rejects.toBe(
      applicationError,
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it("stops at the bounded attempt count and preserves the final error", async () => {
    const finalError = withFlag("durableObjectReset");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(withFlag("durableObjectReset"))
      .mockRejectedValueOnce(withFlag("retryable"))
      .mockRejectedValueOnce(finalError);

    await expect(retryIdempotentDurableObjectOperation({ operation })).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(IDEMPOTENT_DURABLE_OBJECT_LIFECYCLE_MAX_ATTEMPTS);
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

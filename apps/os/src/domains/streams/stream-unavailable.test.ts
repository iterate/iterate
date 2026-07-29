import { describe, expect, it, vi } from "vitest";
import {
  isExplicitStreamKillLifecycleError,
  isDurableObjectLifecycleError,
  isDurableObjectOverloadError,
  isRetryableDurableObjectAvailabilityError,
  isTransientPlatformInternalReferenceError,
  isStreamWaitTimeoutError,
  isStreamUnavailableError,
  rethrowStreamUnavailable,
  retryIdempotentDurableObjectOperation,
  STREAM_KILL_REASON,
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
    ["overloaded flag", withFlag("overloaded"), false],
    [
      "overloaded wins over a simultaneous retryable flag",
      Object.assign(withFlag("retryable"), { overloaded: true }),
      false,
    ],
    ["flag present but not literally true", withFlag("retryable", "yes"), false],
    ["plain Error (app-level throw from the DO)", new Error("kill requested"), false],
    ["string rejection", "kill requested", false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("%s → %s", (_name, error, expected) => {
    expect(isDurableObjectLifecycleError(error)).toBe(expected);
  });
});

describe("isTransientPlatformInternalReferenceError", () => {
  it.each([
    [
      "exact Cloudflare internal reference",
      new Error("internal error; reference = 3c3on0i7t8mchl8ae86jhlad"),
      true,
    ],
    [
      "uppercase exact Cloudflare internal reference",
      new Error("internal error; reference = 3C3ON0I7T8MCHL8AE86JHLAD"),
      true,
    ],
    [
      "application context containing a reference",
      new Error("append failed: internal error; reference = 3c3on0i7t8mchl8ae86jhlad"),
      false,
    ],
    [
      "wrong-length reference",
      new Error("internal error; reference = 3c3on0i7t8mchl8ae86jhla"),
      false,
    ],
    ["non-Error rejection", "internal error; reference = 3c3on0i7t8mchl8ae86jhlad", false],
  ])("%s → %s", (_name, error, expected) => {
    expect(isTransientPlatformInternalReferenceError(error)).toBe(expected);
  });
});

describe("isExplicitStreamKillLifecycleError", () => {
  it("recognises only our direct flagged kill rejection", () => {
    expect(
      isExplicitStreamKillLifecycleError(
        Object.assign(new Error(STREAM_KILL_REASON), { durableObjectReset: true }),
      ),
    ).toBe(true);
    expect(
      isExplicitStreamKillLifecycleError(
        Object.assign(new Error("code updated"), { durableObjectReset: true }),
      ),
    ).toBe(false);
    expect(isExplicitStreamKillLifecycleError(new Error(STREAM_KILL_REASON))).toBe(false);
  });
});

describe("isDurableObjectOverloadError", () => {
  it("recognises direct and wrapped overload without treating lifecycle resets as overload", () => {
    const overload = withFlag("overloaded");
    expect(isDurableObjectOverloadError(overload)).toBe(true);
    expect(
      isDurableObjectOverloadError(new Error("receiver unavailable", { cause: overload })),
    ).toBe(true);
    expect(isDurableObjectOverloadError(withFlag("durableObjectReset"))).toBe(false);
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

  it("retries one exact platform-reference failure and keeps contextual app errors terminal", async () => {
    const platformError = new Error("internal error; reference = 3c3on0i7t8mchl8ae86jhlad");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(platformError)
      .mockResolvedValueOnce("recovered");

    await expect(retryIdempotentDurableObjectOperation({ operation })).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);

    const applicationError = new Error(
      "append failed: internal error; reference = 3c3on0i7t8mchl8ae86jhlad",
    );
    const applicationOperation = vi.fn<() => Promise<string>>().mockRejectedValue(applicationError);
    await expect(
      retryIdempotentDurableObjectOperation({ operation: applicationOperation }),
    ).rejects.toBe(applicationError);
    expect(applicationOperation).toHaveBeenCalledOnce();
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

  it("never retries overload, even when workerd also marks it retryable", async () => {
    const overload = Object.assign(withFlag("overloaded"), { retryable: true });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(overload);

    await expect(retryIdempotentDurableObjectOperation({ operation })).rejects.toBe(overload);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("allows an idempotent operation to veto an otherwise retryable failure", async () => {
    const explicitKill = Object.assign(new Error(STREAM_KILL_REASON), {
      durableObjectReset: true,
    });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(explicitKill);

    await expect(
      retryIdempotentDurableObjectOperation({
        operation,
        retryWhen: (error) => !isExplicitStreamKillLifecycleError(error),
      }),
    ).rejects.toBe(explicitKill);
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("rethrowStreamUnavailable", () => {
  it("tags DO-lifecycle rejections and terminates the remote error shape", () => {
    const original = withFlag("durableObjectReset");
    let caught: unknown;
    try {
      rethrowStreamUnavailable(original);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}kill requested`);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect(isStreamUnavailableError(caught)).toBe(true);
  });

  it("tags an exact platform-reference rejection after bounded replay is exhausted", () => {
    const original = new Error("internal error; reference = 3c3on0i7t8mchl8ae86jhlad");
    expect(() => rethrowStreamUnavailable(original)).toThrow(
      `${STREAM_UNAVAILABLE_MESSAGE_PREFIX}${original.message}`,
    );
  });

  it("preserves an app-level rejection's message in a plain local error", () => {
    const appError = new Error("waitForEvent requires eventTypes or predicate.");
    let caught: unknown;
    try {
      rethrowStreamUnavailable(appError);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBe(appError);
    expect(caught).toEqual(new Error(appError.message));
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

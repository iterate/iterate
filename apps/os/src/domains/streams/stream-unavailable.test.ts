import { describe, expect, it } from "vitest";
import {
  isDurableObjectLifecycleError,
  isStreamUnavailableError,
  retryStreamUnavailable,
  rethrowStreamUnavailable,
  STREAM_UNAVAILABLE_MESSAGE_PREFIX,
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
      "lifecycle flag wrapped by a storage client",
      new Error("cursor ack failed", { cause: withFlag("durableObjectReset") }),
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

describe("retryStreamUnavailable", () => {
  it("reopens a bounded operation after tagged lifecycle interruptions", async () => {
    let calls = 0;
    const result = await retryStreamUnavailable(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}deployment reset`);
      return "ready";
    });

    expect(result).toBe("ready");
    expect(calls).toBe(3);
  });

  it("does not retry an application error", async () => {
    let calls = 0;
    const error = new Error("bad predicate");
    await expect(
      retryStreamUnavailable(async () => {
        calls += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it("stops after the bounded lifecycle attempt budget", async () => {
    let calls = 0;
    await expect(
      retryStreamUnavailable(async () => {
        calls += 1;
        throw new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}still restarting`);
      }),
    ).rejects.toThrow("still restarting");
    expect(calls).toBe(4);
  });
});

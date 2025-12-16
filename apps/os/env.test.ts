import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { waitUntil } from "./env.ts";
import * as tagLogger from "./backend/tag-logger.ts";

// Mock the cloudflare:workers module
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    // Simulate cloudflare's waitUntil by just consuming the promise
    // In real cloudflare workers, this would keep the worker alive
    void promise;
  }),
}));

describe("waitUntil wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should catch synchronous errors thrown in IIFE", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const synchronousError = new Error("Synchronous error");

    // Pass an IIFE that throws synchronously
    waitUntil(
      (async () => {
        throw synchronousError;
      })(),
    );

    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Synchronous error",
      }),
    );
  });

  test("should catch asynchronous errors (promise rejections)", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const asyncError = new Error("Async error");

    waitUntil(
      (async () => {
        throw asyncError;
      })(),
    );

    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Async error",
      }),
    );
  });

  test("should handle rejected promises passed directly", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const rejectionError = new Error("Rejection error");
    const rejectedPromise = Promise.reject(rejectionError);

    waitUntil(rejectedPromise);

    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Rejection error",
      }),
    );
  });

  test("should not throw for successful async operations", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    waitUntil(
      (async () => {
        await Promise.resolve("success");
      })(),
    );

    // Wait a bit to ensure no error is logged
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loggerSpy).not.toHaveBeenCalled();
  });

  test("should not throw for successful promises passed directly", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    waitUntil(Promise.resolve("success"));

    // Wait a bit to ensure no error is logged
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loggerSpy).not.toHaveBeenCalled();
  });

  test("should handle errors thrown after async operations", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const delayedError = new Error("Delayed error");

    waitUntil(
      (async () => {
        await Promise.resolve();
        throw delayedError;
      })(),
    );

    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delayed error",
      }),
    );
  });
});

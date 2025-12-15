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

<<<<<<< HEAD
    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Synchronous error",
      }),
    );
=======
    // Wait for the promise chain to resolve
    await vi.waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Synchronous error (in waitUntil callback, raw error in 'cause')",
          cause: synchronousError,
        }),
      );
    });
>>>>>>> 29182cd08ca98700878c5ec7f29dab89036a8882
  });

  test("should catch asynchronous errors (promise rejections)", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const asyncError = new Error("Async error");

    waitUntil(
      (async () => {
        throw asyncError;
      })(),
    );

<<<<<<< HEAD
    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Async error",
      }),
    );
=======
    await vi.waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Async error (in waitUntil callback, raw error in 'cause')",
          cause: asyncError,
        }),
      );
    });
  });

  test("should capture original stack trace", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const asyncError = new Error("Async error");

    function functionWithBrokenWaitUntil() {
      waitUntil(
        (async () => {
          throw asyncError;
        })(),
      );
    }

    functionWithBrokenWaitUntil();

    await vi.waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Async error (in waitUntil callback, raw error in 'cause')",
          cause: asyncError,
          stack: expect.stringContaining("functionWithBrokenWaitUntil"),
        }),
      );
    });
>>>>>>> 29182cd08ca98700878c5ec7f29dab89036a8882
  });

  test("should handle rejected promises passed directly", async () => {
    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    const rejectionError = new Error("Rejection error");
    const rejectedPromise = Promise.reject(rejectionError);

    waitUntil(rejectedPromise);

<<<<<<< HEAD
    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Rejection error",
      }),
    );
=======
    await vi.waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Rejection error (in waitUntil callback, raw error in 'cause')",
          cause: rejectionError,
        }),
      );
    });
>>>>>>> 29182cd08ca98700878c5ec7f29dab89036a8882
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

<<<<<<< HEAD
    await vi.waitUntil(() => loggerSpy.mock.calls.length);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delayed error",
      }),
    );
=======
    await vi.waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Delayed error (in waitUntil callback, raw error in 'cause')",
          cause: delayedError,
        }),
      );
    });
  });

  test("call stacks are usefully tracked", async () => {
    // this test deals with call stacks, so let's subtract the start line from the error stacks in this file to make it somewhat stable (will still change when the test source code itself is edited)
    const startLine = Number(Error().stack?.split("\n")[1].split(":").at(-2));

    const loggerSpy = vi.spyOn(tagLogger.logger, "error");

    function functionWithBrokenWaitUntil() {
      waitUntil(
        Promise.resolve().then(() => {
          throw new Error("Oh dear");
        }),
      );
    }

    functionWithBrokenWaitUntil();

    const error = await vi.waitUntil(() => {
      const err = loggerSpy.mock.calls?.[0]?.[0] as any;
      return err?.stack && err;
    });
    const simplify = (stack: string) =>
      stack
        .replaceAll(
          new RegExp(`${import.meta.filename}:(\\d+):(\\d+)\\b`, "g"),
          (_, line, column) =>
            `${import.meta.filename.split("/").pop()!}:${line - startLine}:${column}`,
        )
        .replaceAll(
          /file:\/\/\/.*node_modules\/([^/]+)\/.*:\d+:\d+\b/g,
          "node_modules-blah-blah/$1/node_modules-more-blah-blah",
        );

    expect(error).toHaveProperty("stack");

    expect(simplify(error.stack)).toMatchInlineSnapshot(`
      "Oh dear (in waitUntil callback, raw error in 'cause')
          at env.test.ts:7:17
          at functionWithBrokenWaitUntil (env.test.ts:5:7)
          at env.test.ts:12:5
          at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
          at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
          at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
          at new Promise (<anonymous>)
          at runWithTimeout (node_modules-blah-blah/@vitest/node_modules-more-blah-blah)
          at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
          at Traces.$ (node_modules-blah-blah/vitest/node_modules-more-blah-blah)"
    `);

    // this is what we would get if we didn't do some work to keep track of the caller call stack
    expect(simplify(error.cause.stack)).toMatchInlineSnapshot(`
      "Error: Oh dear
          at env.test.ts:7:17"
    `);
>>>>>>> 29182cd08ca98700878c5ec7f29dab89036a8882
  });
});

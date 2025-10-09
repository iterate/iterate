import { describe, expect, test, vi } from "vitest";
import { TagLogger, withLoggerContext } from "./tag-logger.ts";
import { posthogErrorTracking } from "./posthog-error-tracker.ts";

// Mock cloudflare:workers for tests
vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => {});
  },
  env: {} as any,
}));

describe("withLoggerContext", () => {
  test("wraps all methods with logger context", () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const testLogger = new TagLogger({
      info: ({ args }) => calls.push({ method: "info", args }),
      debug: ({ args }) => calls.push({ method: "debug", args }),
      warn: ({ args }) => calls.push({ method: "warn", args }),
      error: ({ args }) => calls.push({ method: "error", args }),
    });

    class TestService {
      value = 0;

      constructor() {
        return withLoggerContext(
          this,
          testLogger,
          (methodName) => ({
            userId: undefined,
            path: undefined,
            method: undefined,
            url: undefined,
            requestId: `test-${methodName}`,
          }),
          posthogErrorTracking,
        );
      }

      async increment() {
        testLogger.info("incrementing");
        this.value++;
        return this.value;
      }

      async decrement() {
        testLogger.info("decrementing");
        this.value--;
        return this.value;
      }

      getValue() {
        return this.value;
      }
    }

    const service = new TestService();

    // Call methods - they should have logger context
    service.increment();
    service.decrement();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(["incrementing"]);
    expect(calls[1]?.args).toEqual(["decrementing"]);
    expect(service.getValue()).toBe(0);
  });

  test("doesn't create nested contexts", async () => {
    const calls: Array<{ level: string; metadata: Record<string, unknown> }> = [];
    const testLogger = new TagLogger({
      info: ({ metadata }) => calls.push({ level: "info", metadata }),
      debug: ({ metadata }) => calls.push({ level: "debug", metadata }),
      warn: ({ metadata }) => calls.push({ level: "warn", metadata }),
      error: ({ metadata }) => calls.push({ level: "error", metadata }),
    });

    class TestService {
      constructor() {
        return withLoggerContext(
          this,
          testLogger,
          (methodName) => ({
            userId: undefined,
            path: undefined,
            method: undefined,
            url: undefined,
            requestId: `test-${methodName}`,
          }),
          posthogErrorTracking,
        );
      }

      async outerMethod() {
        testLogger.info("outer");
        await this.innerMethod();
      }

      async innerMethod() {
        testLogger.info("inner");
      }
    }

    const service = new TestService();
    await service.outerMethod();

    // Should have both logs
    expect(calls).toHaveLength(2);

    // Both should use the outer method's context (first one established)
    expect(calls[0]?.metadata.requestId).toBe("test-outerMethod");
    expect(calls[1]?.metadata.requestId).toBe("test-outerMethod");
  });

  test("works with async methods", async () => {
    const calls: Array<string> = [];
    const testLogger = new TagLogger({
      info: ({ args }) => calls.push(args[0] as string),
      debug: ({ args }) => calls.push(args[0] as string),
      warn: ({ args }) => calls.push(args[0] as string),
      error: ({ args }) => calls.push(args[0] as string),
    });

    class AsyncService {
      constructor() {
        return withLoggerContext(
          this,
          testLogger,
          () => ({
            userId: undefined,
            path: undefined,
            method: undefined,
            url: undefined,
            requestId: "async-test",
          }),
          posthogErrorTracking,
        );
      }

      async fetchData() {
        testLogger.info("start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        testLogger.info("end");
        return "data";
      }
    }

    const service = new AsyncService();
    const result = await service.fetchData();

    expect(result).toBe("data");
    expect(calls).toEqual(["start", "end"]);
  });

  test("preserves method arguments and return values", async () => {
    const testLogger = new TagLogger({
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    });

    class Calculator {
      constructor() {
        return withLoggerContext(
          this,
          testLogger,
          () => ({
            userId: undefined,
            path: undefined,
            method: undefined,
            url: undefined,
            requestId: "calc-test",
          }),
          posthogErrorTracking,
        );
      }

      add(a: number, b: number): number {
        return a + b;
      }

      async multiply(a: number, b: number): Promise<number> {
        return a * b;
      }
    }

    const calc = new Calculator();

    expect(calc.add(2, 3)).toBe(5);
    expect(await calc.multiply(4, 5)).toBe(20);
  });
});

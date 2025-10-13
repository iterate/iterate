import { describe, expect, test, vi } from "vitest";
import { TagLogger, withLoggerContext } from "./tag-logger.ts";

// Mock cloudflare:workers for tests
vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => {});
  },
  env: {} as any,
}));

describe("withLoggerContext", () => {
  test("wraps all methods with logger context", () => {
    const calls: Array<{ method: string; message: string }> = [];
    const testLogger = new TagLogger({
      info: ({ message }) => calls.push({ method: "info", message }),
      debug: ({ message }) => calls.push({ method: "debug", message }),
      warn: ({ message }) => calls.push({ method: "warn", message }),
      error: ({ message }) => calls.push({ method: "error", message }),
    });

    class TestService {
      value = 0;

      constructor() {
        return withLoggerContext(this, testLogger, (methodName) => ({
          userId: undefined,
          path: undefined,
          methodName: undefined,
          url: undefined,
          traceId: `test-${methodName}`,
        }));
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
    expect(calls[0]?.message).toBe("incrementing");
    expect(calls[1]?.message).toBe("decrementing");
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
        return withLoggerContext(this, testLogger, (methodName) => ({
          userId: undefined,
          path: undefined,
          methodName: undefined,
          url: undefined,
          traceId: `test-${methodName}`,
        }));
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
    expect(calls[0]?.metadata.traceId).toBe("test-outerMethod");
    expect(calls[1]?.metadata.traceId).toBe("test-outerMethod");
  });

  test("works with async methods", async () => {
    const calls: Array<string> = [];
    const testLogger = new TagLogger({
      info: ({ message }) => calls.push(message),
      debug: ({ message }) => calls.push(message),
      warn: ({ message }) => calls.push(message),
      error: ({ message }) => calls.push(message),
    });

    class AsyncService {
      constructor() {
        return withLoggerContext(this, testLogger, () => ({
          userId: undefined,
          path: undefined,
          methodName: undefined,
          url: undefined,
          traceId: "async-test",
        }));
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
        return withLoggerContext(this, testLogger, () => ({
          userId: undefined,
          path: undefined,
          methodName: undefined,
          url: undefined,
          traceId: "calc-test",
        }));
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

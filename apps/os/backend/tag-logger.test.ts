import { describe, expect, test, vi } from "vitest";
import { TagLogger } from "./tag-logger.ts";

// Mock cloudflare:workers for tests
vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    // In tests, just run the promise and ignore errors
    promise.catch(() => {});
  },
  env: {} as any, // Mock env for imports (not used in tests)
}));

type LogCall = {
  level: TagLogger.Level;
  args: unknown[];
  metadata: Record<string, unknown>;
};

const createLogger = () => {
  const calls: LogCall[] = [];
  const mocks = {
    info: (call: { args: unknown[]; metadata: Record<string, unknown> }) =>
      calls.push({ level: "info", ...call }),
    warn: (call: { args: unknown[]; metadata: Record<string, unknown> }) =>
      calls.push({ level: "warn", ...call }),
    error: (call: { args: unknown[]; metadata: Record<string, unknown> }) =>
      calls.push({ level: "error", ...call }),
    debug: (call: { args: unknown[]; metadata: Record<string, unknown> }) =>
      calls.push({ level: "debug", ...call }),
  };

  const errorTrackingCalls: Array<{ error: Error; metadata: Record<string, unknown> }> = [];
  const errorTracking: TagLogger.ErrorTrackingFn = (error, metadata) => {
    errorTrackingCalls.push({ error, metadata });
  };

  return {
    mocks,
    calls,
    errorTrackingCalls,
    errorTracking,
    logger: new TagLogger(mocks),
  };
};

const baseMetadata = {
  userId: undefined,
  path: "/test",
  method: "GET",
  url: "http://test.com",
  requestId: "test-123",
};

describe("basic logging", () => {
  test("logs with metadata", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.info("test message", { data: 123 });
    });

    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "test message",
            {
              "data": 123,
            },
          ],
          "level": "info",
          "metadata": {
            "method": "GET",
            "path": "/test",
            "requestId": "test-123",
            "url": "http://test.com",
            "userId": undefined,
          },
        },
      ]
    `);
  });

  test("all log levels work", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.level = "debug"; // Set to debug to see all logs
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error(new Error("error message"));
    });

    expect(calls.map((c) => ({ level: c.level, args: c.args }))).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "debug message",
          ],
          "level": "debug",
        },
        {
          "args": [
            "info message",
          ],
          "level": "info",
        },
        {
          "args": [
            "warn message",
          ],
          "level": "warn",
        },
        {
          "args": [
            [Error: error message],
          ],
          "level": "error",
        },
      ]
    `);
  });

  test("deprecated log method still works", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.log("test");
    });

    expect(calls[0]?.level).toBe("info");
    expect(calls[0]?.args).toEqual(["test"]);
  });
});

describe("metadata management", () => {
  test("withMetadata adds metadata", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.info("before");
      logger.withMetadata({ customKey: "customValue", userId: "user-123" });
      logger.info("after");
    });

    expect(calls[0]?.metadata).toEqual(baseMetadata);
    expect(calls[1]?.metadata).toEqual({
      ...baseMetadata,
      customKey: "customValue",
      userId: "user-123",
    });
  });

  test("removeMetadata removes metadata", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext({ ...baseMetadata, customKey: "value" }, errorTracking, () => {
      logger.info("before");
      logger.removeMetadata("customKey");
      logger.info("after");
    });

    expect(calls[0]?.metadata).toHaveProperty("customKey", "value");
    expect(calls[1]?.metadata).toHaveProperty("customKey", undefined);
  });

  test("getMetadata retrieves metadata", () => {
    const { logger, errorTracking } = createLogger();

    logger.runInContext({ ...baseMetadata, custom: "value" }, errorTracking, () => {
      expect(logger.getMetadata("custom")).toBe("value");
      expect(logger.getMetadata("userId")).toBe(undefined);
      expect(logger.getMetadata()).toEqual({ ...baseMetadata, custom: "value" });
    });
  });

  test("nested contexts inherit and override metadata", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext({ ...baseMetadata, outer: "value" }, errorTracking, () => {
      logger.info("outer");
      logger.runInContext(
        { ...baseMetadata, outer: "value", inner: "nested" },
        errorTracking,
        () => {
          logger.info("inner");
        },
      );
      logger.info("outer again");
    });

    expect(calls[0]?.metadata).toEqual({ ...baseMetadata, outer: "value" });
    expect(calls[1]?.metadata).toEqual({ ...baseMetadata, outer: "value", inner: "nested" });
    expect(calls[2]?.metadata).toEqual({ ...baseMetadata, outer: "value" });
  });
});

describe("log level filtering", () => {
  test("respects log level - only shows info and above by default", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error(new Error("error"));
    });

    // Default level is "info", so debug should not appear
    expect(calls.map((c) => c.level)).toEqual(["info", "warn", "error"]);
  });

  test("can change log level to debug", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.level = "debug";
      logger.debug("debug");
      logger.info("info");
    });

    expect(calls.map((c) => c.level)).toEqual(["debug", "info"]);
  });

  test("can change log level to warn", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.level = "warn";
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error(new Error("error"));
    });

    expect(calls.map((c) => c.level)).toEqual(["warn", "error"]);
  });

  test("can change log level to error", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.level = "error";
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error(new Error("error"));
    });

    expect(calls.map((c) => c.level)).toEqual(["error"]);
  });
});

describe("logs tracking", () => {
  test("tracks logs in context", () => {
    const { logger, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.debug("first");
      logger.info("second");
      logger.warn("third");

      const logs = logger.context.logs;
      expect(logs).toHaveLength(3);
      expect(logs.map((l) => ({ level: l.level, args: l.args }))).toMatchInlineSnapshot(`
        [
          {
            "args": [
              "first",
            ],
            "level": "debug",
          },
          {
            "args": [
              "second",
            ],
            "level": "info",
          },
          {
            "args": [
              "third",
            ],
            "level": "warn",
          },
        ]
      `);
    });
  });

  test("logs have timestamps", () => {
    const { logger, errorTracking } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.info("test");

      const log = logger.context.logs[0];
      expect(log?.timestamp).toBeInstanceOf(Date);
    });
  });
});

describe("error handling", () => {
  test("error with Error object", () => {
    const { logger, calls, errorTracking, errorTrackingCalls } = createLogger();
    const testError = new Error("test error");

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.error(testError);
    });

    expect(calls[0]?.args[0]).toBe(testError);
    expect(errorTrackingCalls).toHaveLength(1);
    expect(errorTrackingCalls[0]?.error).toBe(testError);
    expect(errorTrackingCalls[0]?.metadata).toEqual(baseMetadata);
  });

  test("error with string message", () => {
    const { logger, calls, errorTracking, errorTrackingCalls } = createLogger();

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.error("test error message");
    });

    const loggedError = calls[0]?.args[0] as Error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).toBe("test error message");
    expect(errorTrackingCalls[0]?.error).toBe(loggedError);
  });

  test("error with message and cause", () => {
    const { logger, calls, errorTracking, errorTrackingCalls } = createLogger();
    const causeError = new Error("cause");

    logger.runInContext(baseMetadata, errorTracking, () => {
      logger.error("wrapped error", causeError);
    });

    const loggedError = calls[0]?.args[0] as Error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).toBe("wrapped error");
    expect(loggedError.cause).toBe(causeError);
    expect(errorTrackingCalls[0]?.error).toBe(loggedError);
  });

  test("error tracking receives correct metadata", () => {
    const { logger, errorTracking, errorTrackingCalls } = createLogger();

    logger.runInContext(
      { ...baseMetadata, userId: "user-456", custom: "data" },
      errorTracking,
      () => {
        logger.error(new Error("test"));
      },
    );

    expect(errorTrackingCalls[0]?.metadata).toEqual({
      ...baseMetadata,
      userId: "user-456",
      custom: "data",
    });
  });
});

describe("context independence", () => {
  test("parallel contexts don't interfere with each other", async () => {
    const { logger, calls, errorTracking } = createLogger();

    // Run multiple contexts in parallel
    await Promise.all([
      new Promise<void>((resolve) => {
        logger.runInContext(
          { ...baseMetadata, requestId: "req-1", userId: "user-1" },
          errorTracking,
          () => {
            logger.info("message from context 1");
            resolve();
          },
        );
      }),
      new Promise<void>((resolve) => {
        logger.runInContext(
          { ...baseMetadata, requestId: "req-2", userId: "user-2" },
          errorTracking,
          () => {
            logger.info("message from context 2");
            resolve();
          },
        );
      }),
      new Promise<void>((resolve) => {
        logger.runInContext(
          { ...baseMetadata, requestId: "req-3", userId: "user-3" },
          errorTracking,
          () => {
            logger.info("message from context 3");
            resolve();
          },
        );
      }),
    ]);

    // All three contexts should have logged independently
    expect(calls).toHaveLength(3);

    // Each log should have its own unique metadata
    const requestIds = calls.map((c) => c.metadata.requestId);
    const userIds = calls.map((c) => c.metadata.userId);

    expect(requestIds.sort()).toEqual(["req-1", "req-2", "req-3"]);
    expect(userIds.sort()).toEqual(["user-1", "user-2", "user-3"]);
  });

  test("nested contexts maintain separate state", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext(
      { ...baseMetadata, requestId: "outer", level: "info" },
      errorTracking,
      () => {
        logger.info("outer message");

        logger.runInContext(
          { ...baseMetadata, requestId: "inner", level: "debug" },
          errorTracking,
          () => {
            logger.info("inner message");
          },
        );

        // Back in outer context
        logger.info("outer message 2");
      },
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.metadata.requestId).toBe("outer");
    expect(calls[1]?.metadata.requestId).toBe("inner");
    expect(calls[2]?.metadata.requestId).toBe("outer");
  });

  test("context logs are isolated", () => {
    const { logger, errorTracking } = createLogger();

    let outerLogs: unknown[] = [];
    let innerLogs: unknown[] = [];

    logger.runInContext({ ...baseMetadata, requestId: "outer" }, errorTracking, () => {
      logger.info("outer log 1");
      logger.info("outer log 2");

      logger.runInContext({ ...baseMetadata, requestId: "inner" }, errorTracking, () => {
        logger.info("inner log 1");
        innerLogs = [...logger.context.logs];
      });

      outerLogs = [...logger.context.logs];
    });

    // Inner context should only have inner logs
    expect(innerLogs).toHaveLength(1);
    expect(innerLogs[0]).toMatchObject({
      level: "info",
      args: ["inner log 1"],
    });

    // Outer context should have all outer logs
    expect(outerLogs).toHaveLength(2);
    expect(outerLogs.map((l: any) => l.args[0])).toEqual(["outer log 1", "outer log 2"]);
  });

  test("metadata changes in one context don't affect another", () => {
    const { logger, calls, errorTracking } = createLogger();

    logger.runInContext({ ...baseMetadata, shared: "original" }, errorTracking, () => {
      logger.info("before");

      logger.runInContext({ ...baseMetadata, shared: "nested" }, errorTracking, () => {
        logger.withMetadata({ shared: "modified-nested" });
        logger.info("nested");
      });

      // Should still have original value
      logger.info("after");
    });

    expect(calls[0]?.metadata.shared).toBe("original");
    expect(calls[1]?.metadata.shared).toBe("modified-nested");
    expect(calls[2]?.metadata.shared).toBe("original");
  });
});

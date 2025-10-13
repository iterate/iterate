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
  message: string;
  metadata: Record<string, string | number | boolean | null | undefined>;
  debugMemories?: Array<{ timestamp: Date; message: string }>;
  errorObject?: Error;
};

const createLogger = () => {
  const calls: LogCall[] = [];
  const mocks = {
    info: (call: {
      message: string;
      metadata: Record<string, string | number | boolean | null | undefined>;
    }) => calls.push({ level: "info", ...call }),
    warn: (call: {
      message: string;
      metadata: Record<string, string | number | boolean | null | undefined>;
      debugMemories?: Array<{ timestamp: Date; message: string }>;
    }) => calls.push({ level: "warn", ...call }),
    error: (call: {
      message: string;
      metadata: Record<string, string | number | boolean | null | undefined>;
      debugMemories?: Array<{ timestamp: Date; message: string }>;
      errorObject?: Error;
    }) => calls.push({ level: "error", ...call }),
    debug: (call: {
      message: string;
      metadata: Record<string, string | number | boolean | null | undefined>;
    }) => calls.push({ level: "debug", ...call }),
  };

  return {
    mocks,
    calls,
    logger: new TagLogger(mocks),
  };
};

const baseMetadata = {
  userId: undefined,
  path: "/test",
  httpMethod: "GET",
  url: "http://test.com",
  traceId: "test-123",
};

describe("basic logging", () => {
  test("logs with metadata", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.info("test message", { data: 123 });
    });

    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "debugMemories": undefined,
          "errorObject": undefined,
          "level": "info",
          "message": "test message {"data":123}",
          "metadata": {
            "httpMethod": "GET",
            "path": "/test",
            "traceId": "test-123",
            "url": "http://test.com",
            "userId": undefined,
          },
        },
      ]
    `);
  });

  test("all log levels work", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.level = "debug"; // Set to debug to see all logs
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error(new Error("error message"));
    });

    expect(calls.map((c) => ({ level: c.level, message: c.message }))).toMatchInlineSnapshot(`
      [
        {
          "level": "debug",
          "message": "debug message",
        },
        {
          "level": "info",
          "message": "info message",
        },
        {
          "level": "warn",
          "message": "warn message",
        },
        {
          "level": "error",
          "message": "error message",
        },
      ]
    `);
  });

  test("deprecated log method still works", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.log("test");
    });

    expect(calls[0]?.level).toBe("info");
    expect(calls[0]?.message).toBe("test");
  });
});

describe("metadata management", () => {
  test("addMetadata adds metadata", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.info("before");
      logger.addMetadata({ customKey: "customValue", userId: "user-123" });
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
    const { logger, calls } = createLogger();

    logger.runInContext({ ...baseMetadata, customKey: "value" }, () => {
      logger.info("before");
      logger.removeMetadata("customKey");
      logger.info("after");
    });

    expect(calls[0]?.metadata).toHaveProperty("customKey", "value");
    expect(calls[1]?.metadata).toHaveProperty("customKey", undefined);
  });

  test("getMetadata retrieves metadata", () => {
    const { logger } = createLogger();

    logger.runInContext({ ...baseMetadata, custom: "value" }, () => {
      expect(logger.getMetadata("custom")).toBe("value");
      expect(logger.getMetadata("userId")).toBe(undefined);
      expect(logger.getMetadata()).toEqual({ ...baseMetadata, custom: "value" });
    });
  });

  test("nested contexts inherit and override metadata", () => {
    const { logger, calls } = createLogger();

    logger.runInContext({ ...baseMetadata, outer: "value" }, () => {
      logger.info("outer");
      logger.runInContext({ ...baseMetadata, outer: "value", inner: "nested" }, () => {
        logger.info("inner");
      });
      logger.info("outer again");
    });

    expect(calls[0]?.metadata).toEqual({ ...baseMetadata, outer: "value" });
    expect(calls[1]?.metadata).toEqual({ ...baseMetadata, outer: "value", inner: "nested" });
    expect(calls[2]?.metadata).toEqual({ ...baseMetadata, outer: "value" });
  });
});

describe("log level filtering", () => {
  test("respects log level - only shows info and above by default", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error(new Error("error"));
    });

    // Default level is "info", so debug should not appear
    expect(calls.map((c) => c.level)).toEqual(["info", "warn", "error"]);
  });

  test("can change log level to debug", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.level = "debug";
      logger.debug("debug");
      logger.info("info");
    });

    expect(calls.map((c) => c.level)).toEqual(["debug", "info"]);
  });

  test("can change log level to warn", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.level = "warn";
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error(new Error("error"));
    });

    expect(calls.map((c) => c.level)).toEqual(["warn", "error"]);
  });

  test("can change log level to error", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
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
    const { logger } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.debug("first");
      logger.info("second");
      logger.warn("third");

      const logs = logger.context.logs;
      expect(logs).toHaveLength(3);
      expect(logs.map((l) => ({ level: l.level, message: l.message }))).toMatchInlineSnapshot(`
        [
          {
            "level": "debug",
            "message": "first",
          },
          {
            "level": "info",
            "message": "second",
          },
          {
            "level": "warn",
            "message": "third",
          },
        ]
      `);
    });
  });

  test("logs have timestamps", () => {
    const { logger } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.info("test");

      const log = logger.context.logs[0];
      expect(log?.timestamp).toBeInstanceOf(Date);
    });
  });
});

describe("error handling", () => {
  test("error with Error object", () => {
    const { logger, calls } = createLogger();
    const testError = new Error("test error");

    logger.runInContext(baseMetadata, () => {
      logger.error(testError);
    });

    expect(calls[0]?.message).toBe("test error");
  });

  test("error with string message", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.error("test error message");
    });

    expect(calls[0]?.message).toBe("test error message");
  });

  test("error with message and cause", () => {
    const { logger, calls } = createLogger();
    const causeError = new Error("cause");

    logger.runInContext(baseMetadata, () => {
      logger.error("wrapped error", causeError);
    });

    expect(calls[0]?.message).toBe("wrapped error");
  });

  test("error includes metadata", () => {
    const { logger, calls } = createLogger();

    logger.runInContext({ ...baseMetadata, userId: "user-456", custom: "data" }, () => {
      logger.error(new Error("test"));
    });

    expect(calls[0]?.metadata).toEqual({
      ...baseMetadata,
      userId: "user-456",
      custom: "data",
    });
  });

  test("error with cause includes the cause in errorObject", () => {
    const { logger, calls } = createLogger();
    const causeError = new Error("original cause");
    const wrapperError = new Error("wrapped error", { cause: causeError });

    logger.runInContext(baseMetadata, () => {
      logger.error(wrapperError);
    });

    expect(calls[0]?.message).toBe("wrapped error");
    expect(calls[0]?.errorObject).toBe(wrapperError);
    expect(calls[0]?.errorObject?.cause).toBe(causeError);
  });

  test("error created from string and cause includes the cause", () => {
    const { logger, calls } = createLogger();
    const causeError = new Error("underlying issue");

    logger.runInContext(baseMetadata, () => {
      logger.error("Something went wrong", causeError);
    });

    expect(calls[0]?.message).toBe("Something went wrong");
    expect(calls[0]?.errorObject).toBeInstanceOf(Error);
    expect(calls[0]?.errorObject?.message).toBe("Something went wrong");
    expect(calls[0]?.errorObject?.cause).toBe(causeError);
  });
});

describe("debug memories", () => {
  test("warn and error include debug memories", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.debug("debug 1");
      logger.debug("debug 2");
      logger.info("info message");
      logger.debug("debug 3");
      logger.warn("warning message");
    });

    // Info should not include debug memories
    expect(calls[0]?.debugMemories).toBeUndefined();

    // Warn should include all debug memories from the context
    expect(calls[1]?.debugMemories).toHaveLength(3);
    expect(calls[1]?.debugMemories?.map((m) => m.message)).toEqual([
      "debug 1",
      "debug 2",
      "debug 3",
    ]);
  });

  test("error includes debug memories", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.debug("debug before error");
      logger.info("info message");
      logger.debug("debug right before error");
      logger.error(new Error("test error"));
    });

    expect(calls[1]?.debugMemories).toHaveLength(2);
    expect(calls[1]?.debugMemories?.map((m) => m.message)).toEqual([
      "debug before error",
      "debug right before error",
    ]);
  });

  test("debug logs are still output when level is debug", () => {
    const { logger, calls } = createLogger();

    logger.runInContext(baseMetadata, () => {
      logger.level = "debug";
      logger.debug("debug 1");
      logger.debug("debug 2");
      logger.warn("warning");
    });

    // All debug logs should be in the output
    expect(calls).toHaveLength(3);
    expect(calls[0]?.level).toBe("debug");
    expect(calls[1]?.level).toBe("debug");
    expect(calls[2]?.level).toBe("warn");

    // And the warn should still include memories
    expect(calls[2]?.debugMemories).toHaveLength(2);
  });
});

describe("context independence", () => {
  test("parallel contexts don't interfere with each other", async () => {
    const { logger, calls } = createLogger();

    // Run multiple contexts in parallel
    await Promise.all([
      new Promise<void>((resolve) => {
        logger.runInContext({ ...baseMetadata, requestId: "req-1", userId: "user-1" }, () => {
          logger.info("message from context 1");
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        logger.runInContext({ ...baseMetadata, requestId: "req-2", userId: "user-2" }, () => {
          logger.info("message from context 2");
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        logger.runInContext({ ...baseMetadata, requestId: "req-3", userId: "user-3" }, () => {
          logger.info("message from context 3");
          resolve();
        });
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
    const { logger, calls } = createLogger();

    logger.runInContext({ ...baseMetadata, requestId: "outer", level: "info" }, () => {
      logger.info("outer message");

      logger.runInContext({ ...baseMetadata, requestId: "inner", level: "debug" }, () => {
        logger.info("inner message");
      });

      // Back in outer context
      logger.info("outer message 2");
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.metadata.requestId).toBe("outer");
    expect(calls[1]?.metadata.requestId).toBe("inner");
    expect(calls[2]?.metadata.requestId).toBe("outer");
  });

  test("context logs are isolated", () => {
    const { logger } = createLogger();

    let outerLogs: unknown[] = [];
    let innerLogs: unknown[] = [];

    logger.runInContext({ ...baseMetadata, requestId: "outer" }, () => {
      logger.info("outer log 1");
      logger.info("outer log 2");

      logger.runInContext({ ...baseMetadata, requestId: "inner" }, () => {
        logger.info("inner log 1");
        innerLogs = [...logger.context.logs];
      });

      outerLogs = [...logger.context.logs];
    });

    // Inner context should only have inner logs
    expect(innerLogs).toHaveLength(1);
    expect(innerLogs[0]).toMatchObject({
      level: "info",
      message: "inner log 1",
    });

    // Outer context should have all outer logs
    expect(outerLogs).toHaveLength(2);
    expect(outerLogs.map((l: any) => l.message)).toEqual(["outer log 1", "outer log 2"]);
  });

  test("metadata changes in one context don't affect another", () => {
    const { logger, calls } = createLogger();

    logger.runInContext({ ...baseMetadata, shared: "original" }, () => {
      logger.info("before");

      logger.runInContext({ ...baseMetadata, shared: "nested" }, () => {
        logger.addMetadata({ shared: "modified-nested" });
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

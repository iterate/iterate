import { describe, expect, test, vi } from "vitest";
import { TagLogger, createLoggerMiddleware } from "./tag-logger.ts";
import { posthogErrorTracking } from "./posthog-error-tracker.ts";

// Mock cloudflare:workers for tests
vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => {});
  },
  env: {} as any,
}));

// Simulate a simple Hono-like context
type MockContext = {
  req: {
    path: string;
    method: string;
    url: string;
  };
  var: {
    session?: {
      user?: {
        id: string;
      };
    };
  };
};

describe("createLoggerMiddleware", () => {
  test("middleware sets up logger context for the request", async () => {
    const calls: Array<{ args: unknown[]; metadata: Record<string, unknown> }> = [];
    const testLogger = new TagLogger({
      info: ({ args, metadata }) => calls.push({ args, metadata }),
      debug: ({ args, metadata }) => calls.push({ args, metadata }),
      warn: ({ args, metadata }) => calls.push({ args, metadata }),
      error: ({ args, metadata }) => calls.push({ args, metadata }),
    });

    const middleware = createLoggerMiddleware<MockContext>(
      testLogger,
      (c) => ({
        userId: c.var.session?.user?.id || undefined,
        path: c.req.path,
        method: c.req.method,
        url: c.req.url,
        requestId: "test-req-123",
      }),
      posthogErrorTracking,
    );

    const mockContext: MockContext = {
      req: {
        path: "/api/test",
        method: "GET",
        url: "http://example.com/api/test",
      },
      var: {
        session: {
          user: {
            id: "user-456",
          },
        },
      },
    };

    let handlerCalled = false;
    const next = async () => {
      handlerCalled = true;
      // Log something inside the handler
      testLogger.info("Inside handler");
    };

    await middleware(mockContext, next);

    expect(handlerCalled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["Inside handler"]);
    expect(calls[0]?.metadata).toEqual({
      userId: "user-456",
      path: "/api/test",
      method: "GET",
      url: "http://example.com/api/test",
      requestId: "test-req-123",
    });
  });

  test("middleware works with unauthenticated requests", async () => {
    const calls: Array<{ metadata: Record<string, unknown> }> = [];
    const testLogger = new TagLogger({
      info: ({ metadata }) => calls.push({ metadata }),
      debug: ({ metadata }) => calls.push({ metadata }),
      warn: ({ metadata }) => calls.push({ metadata }),
      error: ({ metadata }) => calls.push({ metadata }),
    });

    const middleware = createLoggerMiddleware<MockContext>(
      testLogger,
      (c) => ({
        userId: c.var.session?.user?.id || undefined,
        path: c.req.path,
        method: c.req.method,
        url: c.req.url,
        requestId: "test-req-789",
      }),
      posthogErrorTracking,
    );

    const mockContext: MockContext = {
      req: {
        path: "/api/public",
        method: "POST",
        url: "http://example.com/api/public",
      },
      var: {},
    };

    const next = async () => {
      testLogger.warn("Public endpoint accessed");
    };

    await middleware(mockContext, next);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata.userId).toBe(undefined);
    expect(calls[0]?.metadata.path).toBe("/api/public");
    expect(calls[0]?.metadata.method).toBe("POST");
  });

  test("middleware handles async operations correctly", async () => {
    const logs: string[] = [];
    const testLogger = new TagLogger({
      info: ({ args }) => logs.push(args[0] as string),
      debug: ({ args }) => logs.push(args[0] as string),
      warn: ({ args }) => logs.push(args[0] as string),
      error: ({ args }) => logs.push(args[0] as string),
    });

    const middleware = createLoggerMiddleware<MockContext>(
      testLogger,
      (c) => ({
        userId: undefined,
        path: c.req.path,
        method: c.req.method,
        url: c.req.url,
        requestId: "async-req",
      }),
      posthogErrorTracking,
    );

    const mockContext: MockContext = {
      req: {
        path: "/api/async",
        method: "GET",
        url: "http://example.com/api/async",
      },
      var: {},
    };

    const next = async () => {
      testLogger.info("Before async");
      await new Promise((resolve) => setTimeout(resolve, 10));
      testLogger.info("After async");
    };

    await middleware(mockContext, next);

    expect(logs).toEqual(["Before async", "After async"]);
  });

  test("middleware propagates errors correctly", async () => {
    const testLogger = new TagLogger({
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    });

    const middleware = createLoggerMiddleware<MockContext>(
      testLogger,
      (c) => ({
        userId: undefined,
        path: c.req.path,
        method: c.req.method,
        url: c.req.url,
        requestId: "error-req",
      }),
      posthogErrorTracking,
    );

    const mockContext: MockContext = {
      req: {
        path: "/api/error",
        method: "GET",
        url: "http://example.com/api/error",
      },
      var: {},
    };

    const testError = new Error("Test error");
    const next = async () => {
      throw testError;
    };

    await expect(middleware(mockContext, next)).rejects.toThrow("Test error");
  });

  test("each request gets isolated context", async () => {
    const calls: Array<{ metadata: Record<string, unknown> }> = [];
    const testLogger = new TagLogger({
      info: ({ metadata }) => calls.push({ metadata }),
      debug: ({ metadata }) => calls.push({ metadata }),
      warn: ({ metadata }) => calls.push({ metadata }),
      error: ({ metadata }) => calls.push({ metadata }),
    });

    const middleware = createLoggerMiddleware<MockContext>(
      testLogger,
      (c) => ({
        userId: c.var.session?.user?.id || undefined,
        path: c.req.path,
        method: c.req.method,
        url: c.req.url,
        requestId: `req-${c.req.path}`,
      }),
      posthogErrorTracking,
    );

    // Simulate two separate requests
    const request1: MockContext = {
      req: {
        path: "/api/request1",
        method: "GET",
        url: "http://example.com/api/request1",
      },
      var: { session: { user: { id: "user-1" } } },
    };

    const request2: MockContext = {
      req: {
        path: "/api/request2",
        method: "POST",
        url: "http://example.com/api/request2",
      },
      var: { session: { user: { id: "user-2" } } },
    };

    await middleware(request1, async () => {
      testLogger.info("Request 1");
    });

    await middleware(request2, async () => {
      testLogger.info("Request 2");
    });

    expect(calls).toHaveLength(2);
    // Each request should have its own context
    expect(calls[0]?.metadata.requestId).toBe("req-/api/request1");
    expect(calls[0]?.metadata.userId).toBe("user-1");
    expect(calls[1]?.metadata.requestId).toBe("req-/api/request2");
    expect(calls[1]?.metadata.userId).toBe("user-2");
  });
});

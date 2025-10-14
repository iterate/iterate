import { describe, expect, test, vi } from "vitest";
import { TagLogger } from "./tag-logger.ts";
import { createLoggerMiddleware } from "./tag-logger-middleware.ts";

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
    const calls: Array<{
      message: string;
      metadata: Record<string, string | number | boolean | null | undefined>;
    }> = [];
    const testLogger = new TagLogger({
      info: ({ message, metadata }) => calls.push({ message, metadata }),
      debug: ({ message, metadata }) => calls.push({ message, metadata }),
      warn: ({ message, metadata }) => calls.push({ message, metadata }),
      error: ({ message, metadata }) => calls.push({ message, metadata }),
    });

    const middleware = createLoggerMiddleware(testLogger, (c: MockContext) => ({
      userId: c.var.session?.user?.id || undefined,
      path: c.req.path,
      httpMethod: c.req.method,
      url: c.req.url,
      traceId: "test-req-123",
    }));

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

    await middleware(mockContext as any, next);

    expect(handlerCalled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("Inside handler");
    expect(calls[0]?.metadata).toEqual({
      userId: "user-456",
      path: "/api/test",
      httpMethod: "GET",
      url: "http://example.com/api/test",
      traceId: "test-req-123",
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

    const middleware = createLoggerMiddleware(testLogger, (c: MockContext) => ({
      userId: c.var.session?.user?.id || undefined,
      path: c.req.path,
      httpMethod: c.req.method,
      url: c.req.url,
      traceId: "test-req-789",
    }));

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

    await middleware(mockContext as any, next);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata.userId).toBe(undefined);
    expect(calls[0]?.metadata.path).toBe("/api/public");
    expect(calls[0]?.metadata.httpMethod).toBe("POST");
  });

  test("middleware handles async operations correctly", async () => {
    const logs: string[] = [];
    const testLogger = new TagLogger({
      info: ({ message }) => logs.push(message),
      debug: ({ message }) => logs.push(message),
      warn: ({ message }) => logs.push(message),
      error: ({ message }) => logs.push(message),
    });

    const middleware = createLoggerMiddleware(testLogger, (c: MockContext) => ({
      userId: undefined,
      path: c.req.path,
      httpMethod: c.req.method,
      url: c.req.url,
      traceId: "async-req",
    }));

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

    await middleware(mockContext as any, next);

    expect(logs).toEqual(["Before async", "After async"]);
  });

  test("middleware propagates errors correctly", async () => {
    const testLogger = new TagLogger({
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    });

    const middleware = createLoggerMiddleware(testLogger, (c: MockContext) => ({
      userId: undefined,
      path: c.req.path,
      httpMethod: c.req.method,
      url: c.req.url,
      traceId: "error-req",
    }));

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

    await expect(middleware(mockContext as any, next)).rejects.toThrow("Test error");
  });

  test("each request gets isolated context", async () => {
    const calls: Array<{ metadata: Record<string, unknown> }> = [];
    const testLogger = new TagLogger({
      info: ({ metadata }) => calls.push({ metadata }),
      debug: ({ metadata }) => calls.push({ metadata }),
      warn: ({ metadata }) => calls.push({ metadata }),
      error: ({ metadata }) => calls.push({ metadata }),
    });

    const middleware = createLoggerMiddleware(testLogger, (c: MockContext) => ({
      userId: c.var.session?.user?.id || undefined,
      path: c.req.path,
      httpMethod: c.req.method,
      url: c.req.url,
      traceId: `req-${c.req.path}`,
    }));

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

    await middleware(request1 as any, async () => {
      testLogger.info("Request 1");
    });

    await middleware(request2 as any, async () => {
      testLogger.info("Request 2");
    });

    expect(calls).toHaveLength(2);
    // Each request should have its own context
    expect(calls[0]?.metadata.traceId).toBe("req-/api/request1");
    expect(calls[0]?.metadata.userId).toBe("user-1");
    expect(calls[1]?.metadata.traceId).toBe("req-/api/request2");
    expect(calls[1]?.metadata.userId).toBe("user-2");
  });
});

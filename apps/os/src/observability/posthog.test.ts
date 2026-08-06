import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  captureExceptionImmediate: vi.fn(),
  construct: vi.fn(),
  errorListener: undefined as ((error: unknown) => void) | undefined,
  shutdown: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(apiKey: string, options: unknown) {
      sdk.construct(apiKey, options);
    }

    on(_event: string, listener: (error: unknown) => void) {
      sdk.errorListener = listener;
      return () => {
        sdk.errorListener = undefined;
      };
    }

    captureExceptionImmediate(
      error: unknown,
      distinctId?: string,
      properties?: Record<string, unknown>,
    ) {
      return sdk.captureExceptionImmediate(error, distinctId, properties);
    }

    shutdown(timeout?: number) {
      return sdk.shutdown(timeout);
    }
  },
}));

import { schedulePosthogException, withPosthogExceptionCapture } from "./posthog.ts";
import type { AppConfig } from "~/config.ts";

const config = {
  cloudflare: { workerName: "os-prd" },
  environmentName: "prd",
  posthog: { apiKey: "phc_test" },
} as Pick<AppConfig, "cloudflare" | "environmentName" | "posthog">;

function captureContext(operation: object = {}) {
  const pending: Promise<unknown>[] = [];
  return {
    input: {
      config,
      operation,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    },
    pending,
  };
}

describe("backend PostHog exception capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.errorListener = undefined;
    sdk.captureExceptionImmediate.mockResolvedValue(undefined);
    sdk.shutdown.mockResolvedValue(undefined);
  });

  it("uses a request-scoped Cloudflare client with person and project context", async () => {
    const { input, pending } = captureContext();
    const error = new Error("server failed");

    schedulePosthogException({
      ...input,
      distinctId: "usr_123",
      error,
      projectId: "prj_123",
      request: new Request("https://os.iterate.com/projects/test?token=ok"),
    });
    await Promise.all(pending);

    expect(sdk.construct).toHaveBeenCalledWith("phc_test", {
      fetchRetryCount: 1,
      fetchRetryDelay: 1_000,
      flushAt: 1,
      flushInterval: 0,
      host: "https://eu.i.posthog.com",
      requestTimeout: 5_000,
    });
    expect(sdk.captureExceptionImmediate).toHaveBeenCalledWith(error, "usr_123", {
      $current_url: "https://os.iterate.com/projects/test",
      $environment: "os-prd",
      $groups: { project: "prj_123" },
      http_method: "GET",
    });
    expect(sdk.shutdown).toHaveBeenCalledWith(2_000);
  });

  it("is disabled when the public PostHog key is absent", () => {
    const { input, pending } = captureContext();

    schedulePosthogException({
      ...input,
      config: { ...config, posthog: undefined },
      error: new Error("not sent"),
    });

    expect(pending).toEqual([]);
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("deduplicates nested boundaries and rethrows the original value", async () => {
    const operation = {};
    const { input, pending } = captureContext(operation);
    const error = new Error("original");

    await expect(withPosthogExceptionCapture(input, () => Promise.reject(error))).rejects.toBe(
      error,
    );
    await expect(withPosthogExceptionCapture(input, () => Promise.reject(error))).rejects.toBe(
      error,
    );
    await Promise.all(pending);

    expect(sdk.captureExceptionImmediate).toHaveBeenCalledOnce();
  });

  it("logs delivery failure without replacing the product error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.captureExceptionImmediate.mockRejectedValue(new Error("PostHog unavailable"));
    const { input, pending } = captureContext();
    const productError = new Error("product failed");

    await expect(
      withPosthogExceptionCapture(input, () => Promise.reject(productError)),
    ).rejects.toBe(productError);
    await Promise.all(pending);

    expect(consoleError).toHaveBeenCalledWith({
      error: { name: "Error" },
      message: "posthog_exception_capture_failed",
      schema: "iterate.posthog.v1",
    });
  });
});

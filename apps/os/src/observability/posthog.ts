import { PostHog } from "posthog-node";
import type { AppConfig } from "~/config.ts";

const POSTHOG_HOST = "https://eu.i.posthog.com";
const scheduledOperations = new WeakSet<object>();

type PosthogExceptionContext = {
  config: Pick<AppConfig, "cloudflare" | "posthog">;
  distinctId?: string;
  /** One unique object per Cloudflare invocation; deduplicates nested boundaries. */
  operation: object;
  projectId?: string;
  properties?: Record<string, unknown>;
  request?: Request;
  waitUntil: (promise: Promise<unknown>) => void;
};

/** Capture and rethrow at a backend boundary. */
export async function withPosthogExceptionCapture<T>(
  input: PosthogExceptionContext,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Analytics must never replace the operation's original failure, including
    // if a test/runtime implementation of waitUntil throws synchronously.
    try {
      schedulePosthogException({ ...input, error });
    } catch (captureError) {
      reportPosthogCaptureFailure(captureError);
    }
    throw error;
  }
}

/** Report an unhandled backend exception without changing the failed operation. */
export function schedulePosthogException(input: PosthogExceptionContext & { error: unknown }) {
  try {
    const apiKey = input.config.posthog?.apiKey;
    if (!apiKey || scheduledOperations.has(input.operation)) return;
    scheduledOperations.add(input.operation);

    const capture = capturePosthogException({ ...input, apiKey }).catch(
      reportPosthogCaptureFailure,
    );
    input.waitUntil(capture);
  } catch (error) {
    // Delivery telemetry is fail-open for the product operation, but its own
    // failure remains visible in Cloudflare logs.
    try {
      reportPosthogCaptureFailure(error);
    } catch {
      // A hostile console shim must not be able to replace the product error.
    }
  }
}

async function capturePosthogException(
  input: PosthogExceptionContext & { apiKey: string; error: unknown },
) {
  const client = new PostHog(input.apiKey, {
    host: POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    // Cloudflare allows waitUntil work for 30 seconds after an HTTP response.
    // Two 5s attempts plus one 1s delay stay comfortably inside that budget.
    fetchRetryCount: 1,
    fetchRetryDelay: 1_000,
    requestTimeout: 5_000,
  });
  let deliveryFailureReported = false;
  const reportDeliveryFailure = (error: unknown) => {
    if (deliveryFailureReported) return;
    deliveryFailureReported = true;
    reportPosthogCaptureFailure(error);
  };
  const removeErrorListener = client.on("error", reportDeliveryFailure);
  const properties: Record<string, unknown> = {
    $environment: input.config.cloudflare.workerName ?? "os-local",
    ...(input.projectId ? { $groups: { project: input.projectId } } : {}),
    ...requestProperties(input.request),
    ...input.properties,
  };

  try {
    await client.captureExceptionImmediate(input.error, input.distinctId, properties);
  } catch (error) {
    reportDeliveryFailure(error);
  } finally {
    try {
      await client.shutdown(2_000);
    } catch (error) {
      reportDeliveryFailure(error);
    } finally {
      removeErrorListener();
    }
  }
}

function reportPosthogCaptureFailure(error: unknown) {
  console.error({
    schema: "iterate.posthog.v1",
    message: "posthog_exception_capture_failed",
    error: { name: error instanceof Error ? error.name : "NonErrorThrowable" },
  });
}

function requestProperties(request?: Request) {
  if (!request) return {};
  const url = new URL(request.url);
  return {
    $current_url: `${url.origin}${url.pathname}`,
    http_method: request.method,
    ...(request.headers.get("cf-ray") ? { cf_ray: request.headers.get("cf-ray") } : {}),
  };
}

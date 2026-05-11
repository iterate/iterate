import { os } from "~/orpc/orpc.ts";

export const testRouter = {
  test: {
    logDemo: os.test.logDemo.handler(async ({ context, input }) => {
      const requestId = readRequestIdFromLog(context.log);
      const steps = [
        "request-received",
        "parsed-input",
        "dependency-slow-warning",
        "dependency-error",
        "recovered",
        "completed",
      ] as const;
      const startedAt = new Date().toISOString();
      const job = {
        label: input.label,
        requestId,
        jobId: `log-demo:${requestId.slice(0, 8)}`,
        source: "debug-page-button",
      };

      context.log.set({
        logDemo: {
          ...job,
          startedAt,
          steps,
        },
      });
      context.log.info("example.test.log-demo.received", {
        logDemo: {
          phase: "request-received",
          browserInput: input,
        },
      });

      await sleep(120);

      context.log.info("example.test.log-demo.parsed-input", {
        logDemo: {
          phase: "parsed-input",
          parsedConfig: {
            shouldEmitWarning: true,
            shouldEmitError: true,
            simulatedDelayMs: 120,
          },
        },
      });

      await sleep(180);

      context.log.warn("example.test.log-demo.dependency-slow", {
        logDemo: {
          phase: "dependency-slow-warning",
          dependency: {
            name: "pirate-weather-api",
            region: "us-east-1",
            latencyMs: 742,
          },
          retriesRemaining: 1,
        },
      });

      await sleep(240);

      const downstreamError = new Error(
        "Simulated downstream timeout while fetching pirate weather",
      );
      context.log.error(downstreamError, {
        logDemo: {
          phase: "dependency-error",
          dependency: {
            name: "pirate-weather-api",
            operation: "fetch-forecast",
          },
          attempt: 2,
          fallback: "stale-cache",
        },
      });

      await sleep(150);

      context.log.info("example.test.log-demo.recovered", {
        logDemo: {
          phase: "recovered",
          responseSource: "stale-cache",
          cacheAgeMs: 2_400,
        },
      });

      await sleep(90);

      context.log.info("example.test.log-demo.completed", {
        logDemo: {
          phase: "completed",
          totalSteps: steps.length,
          endedAt: new Date().toISOString(),
        },
      });

      return {
        ok: true as const,
        label: input.label,
        requestId,
        steps: [...steps],
      };
    }),
    serverThrow: os.test.serverThrow.handler(async ({ input }): Promise<never> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error(input.message);
    }),
    randomLogStream: os.test.randomLogStream.handler(async function* ({ input, context, signal }) {
      context.log.set({
        randomLogStream: {
          count: input.count,
          minDelayMs: input.minDelayMs,
          maxDelayMs: input.maxDelayMs,
        },
      });
      context.log.info("example.test.random-log-stream.started");

      try {
        for (let index = 0; index < input.count; index += 1) {
          if (signal?.aborted) {
            return;
          }

          const delayMs = randomIntBetween(input.minDelayMs, input.maxDelayMs);
          await sleep(delayMs, signal);
          if (signal?.aborted) {
            return;
          }

          const value = Math.random().toFixed(6);
          yield `${new Date().toISOString()} random[${index + 1}/${input.count}] delay=${delayMs}ms value=${value}`;
        }
      } finally {
        context.log.info("example.test.random-log-stream.closed");
      }
    }),
  },
};

function randomIntBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readRequestIdFromLog(log: { getContext(): Record<string, unknown> }) {
  const requestId = log.getContext().requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new Error("Request log is missing requestId.");
  }
  return requestId;
}

import { setTimeout as delay } from "node:timers/promises";
import { Bash } from "just-bash";
import { afterEach, describe, expect, test } from "vitest";
import {
  createWorkshopTestHarness,
  PullSubscriptionPatternProcessorRuntime,
  type Event,
  type StreamPath,
} from "ai-engineer-workshop";
import bashmode, { BashmodeBlockAddedEventInput } from "./bashmode.ts";

const app = createWorkshopTestHarness({
  baseUrl: "https://events.iterate.com",
  projectSlug: "public",
});
const runtime = startBashmodeRuntime(app);
const samePath = app.createTestStreamPath("bashmode-same-path");
const targetPath = app.createTestChildStreamPath({
  childSlug: "target",
  testName: "bashmode-cross-path",
});

const proofs = await collectProofs();

afterEach(() => {
  destroyLingeringSockets();
});

describe("bashmode", () => {
  test("turns bash output into agent-input-added", () => {
    expect(readContent(proofs.samePathResult)).toBe(
      ["Bash result:", "stdout:", "hello from bashmode\n", "stderr:", "", "exitCode: 0"].join("\n"),
    );
  }, 5_000);

  test("curl can append agent-input-added to another path", () => {
    expect(readContent(proofs.crossPathTargetResult)).toBe("hello from another path");
  }, 5_000);
});

function startBashmodeRuntime(app: ReturnType<typeof createWorkshopTestHarness>) {
  const runtime = new PullSubscriptionPatternProcessorRuntime({
    eventsClient: app.client,
    processor: bashmode,
    streamPattern: `${app.runRootPath}/**`,
  });
  const runPromise = runtime.run();

  return {
    runtime,
    async stopAndWait() {
      runtime.stop();
      await Promise.race([runPromise.catch(() => undefined), delay(1_000)]);
    },
  };
}

async function discoverStreamPath(args: {
  app: ReturnType<typeof createWorkshopTestHarness>;
  runtime: ReturnType<typeof startBashmodeRuntime>;
  streamPath: StreamPath;
}) {
  await appendWithRetry({
    path: args.streamPath,
    event: {
      type: "warmup",
      payload: { ok: true },
    },
  });

  await waitFor(
    async () => args.runtime.runtime.getStreamPaths().includes(args.streamPath),
    20_000,
  );
}

async function waitForEvent(args: {
  app: ReturnType<typeof createWorkshopTestHarness>;
  predicate: (event: Event) => boolean;
  streamPath: StreamPath;
  timeoutMs?: number;
}) {
  return args.app.waitForEvent({
    predicate: args.predicate,
    streamPath: args.streamPath,
    timeoutMs: args.timeoutMs ?? 4_000,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000) {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out");
    }

    await delay(100);
  }
}

async function appendWithRetry(
  input: Parameters<ReturnType<typeof createWorkshopTestHarness>["append"]>[0],
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await app.append(input);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes("Internal server error")) {
        throw error;
      }

      await delay(100);
    }
  }

  throw lastError;
}

async function retryBashmodeBlock(args: {
  blockContent: string;
  predicate: (event: Event) => boolean;
  appendPath: StreamPath;
  waitPath?: StreamPath;
}) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await appendWithRetry({
      path: args.appendPath,
      event: BashmodeBlockAddedEventInput.parse({
        type: "bashmode-block-added",
        payload: {
          content: args.blockContent,
        },
      }),
    });

    try {
      return await waitForEvent({
        app,
        predicate: args.predicate,
        streamPath: args.waitPath ?? args.appendPath,
        timeoutMs: 8_000,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function collectProofs() {
  try {
    await discoverStreamPath({ app, runtime, streamPath: samePath });

    const samePathEvent = await retryBashmodeBlock({
      blockContent: 'echo "hello from bashmode"',
      predicate: (event) => event.type === "agent-input-added",
      appendPath: samePath,
    });

    const body = JSON.stringify({
      type: "agent-input-added",
      payload: { content: "hello from another path" },
    });
    const bash = new Bash({
      env: {
        BASE_URL: "https://events.iterate.com",
        PROJECT_SLUG: "public",
      },
      network: {
        dangerouslyAllowFullInternetAccess: true,
      },
    });
    const curlResult = await bash.exec(
      [
        `curl`,
        `-d ${JSON.stringify(body)}`,
        `-H "content-type: application/json"`,
        `-H "x-iterate-project: $PROJECT_SLUG"`,
        `"$BASE_URL/api/streams${targetPath}"`,
      ].join(" "),
    );
    if (curlResult.exitCode !== 0) {
      throw new Error(
        curlResult.stderr || curlResult.stdout || `curl failed with ${curlResult.exitCode}`,
      );
    }
    const crossPathTargetEvent = await waitForEvent({
      app,
      predicate: (event) =>
        event.type === "agent-input-added" && readContent(event) === "hello from another path",
      streamPath: targetPath,
      timeoutMs: 20_000,
    });

    return {
      samePathResult: samePathEvent,
      crossPathTargetResult: crossPathTargetEvent,
    };
  } finally {
    await runtime.stopAndWait();
  }
}

function readContent(event: Event) {
  if (
    typeof event.payload !== "object" ||
    event.payload == null ||
    !("content" in event.payload) ||
    typeof event.payload.content !== "string"
  ) {
    throw new Error("Expected event payload.content to be a string");
  }

  return event.payload.content;
}

function destroyLingeringSockets() {
  const getHandles = Reflect.get(process, "_getActiveHandles");
  const handles = typeof getHandles === "function" ? getHandles.call(process) : undefined;
  if (!Array.isArray(handles)) return;

  for (const handle of handles) {
    if (
      typeof handle === "object" &&
      handle != null &&
      "constructor" in handle &&
      handle.constructor?.name === "Socket" &&
      "destroy" in handle &&
      typeof handle.destroy === "function"
    ) {
      handle.destroy();
    }
  }
}

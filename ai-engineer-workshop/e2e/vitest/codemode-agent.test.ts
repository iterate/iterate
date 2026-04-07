import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkshopTestHarness } from "ai-engineer-workshop";
import { createAgentProcessor } from "../../examples/04-llm-codemode/agent.ts";
import {
  llmInputAddedType,
  llmRequestCanceledType,
  llmRequestCompletedType,
  llmRequestStartedType,
} from "../../examples/04-llm-codemode/agent-types.ts";
import { createCodemodeProcessor } from "../../examples/04-llm-codemode/codemode.ts";
import {
  CodemodeResultAddedPayload,
  codemodeBlockAddedType,
  codemodeResultAddedType,
} from "../../examples/04-llm-codemode/codemode-types.ts";
import { destroyLingeringSockets } from "./slack-codemode-agent.helpers.ts";

const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const app = createWorkshopTestHarness();
const describeCodemodeAgent = openAiApiKey == null ? describe.skip : describe;

afterEach(() => {
  destroyLingeringSockets();
});

describeCodemodeAgent("codemode agent", () => {
  test("cancels an in-flight request, executes codemode, and mirrors the result back into the loop", async () => {
    const testName = expect.getState().currentTestName ?? "codemode-agent";
    const streamPath = app.createTestStreamPath(testName);
    const codemodeRootDirectory = path.resolve(process.cwd(), ".codemode", "tests", "loop");
    const runtime = await app.startProcessors({
      processors: [
        createAgentProcessor({
          agentPath: streamPath,
          apiKey: openAiApiKey!,
          baseUrl: app.baseUrl,
          codemodeRootDirectory,
          model: openAiModel,
          projectSlug: app.projectSlug,
          workingDirectory: process.cwd(),
        }),
        createCodemodeProcessor({
          codemodeRootDirectory,
        }),
      ],
      streamPath,
    });

    try {
      await app.append({
        path: streamPath,
        event: {
          type: llmInputAddedType,
          payload: {
            content: [
              "Start replying immediately.",
              "Count from 1 to 200, each on its own line.",
              "Do not use a code block.",
            ].join(" "),
            source: "user",
          },
        },
      });

      await app.waitForEvent({
        predicate: (event) => event.type === llmRequestStartedType,
        streamPath,
        timeoutMs: 30_000,
      });

      await app.append({
        path: streamPath,
        event: {
          type: llmInputAddedType,
          payload: {
            content: [
              "Ignore the previous request.",
              "Reply with exactly one executable ```ts``` block and nothing else.",
              'The code must compile and print `{"proof":"passed"}`.',
            ].join(" "),
            source: "user",
          },
        },
      });

      const codemodeResultEvent = await app.waitForEvent({
        predicate: (event) => {
          if (event.type !== codemodeResultAddedType) {
            return false;
          }

          const parsed = CodemodeResultAddedPayload.safeParse(event.payload);
          return (
            parsed.success && parsed.data.success && parsed.data.stdout.includes('"proof":"passed"')
          );
        },
        streamPath,
        timeoutMs: 60_000,
      });

      const parsedResult = CodemodeResultAddedPayload.parse(codemodeResultEvent.payload);
      const outputText = await fs.readFile(parsedResult.outputPath, "utf8");

      expect(outputText).toContain('{"proof":"passed"}');
      await expect(fs.readFile(parsedResult.codePath, "utf8")).resolves.toContain("proof");

      const mirroredInput = await app.waitForEvent({
        predicate: (event) =>
          event.type === llmInputAddedType &&
          typeof event.payload === "object" &&
          event.payload != null &&
          "source" in event.payload &&
          event.payload.source === "event" &&
          "sourceEventType" in event.payload &&
          event.payload.sourceEventType === codemodeResultAddedType,
        streamPath,
        timeoutMs: 30_000,
      });

      const events = await app.collectEvents(streamPath);

      expect(mirroredInput.type).toBe(llmInputAddedType);
      expect(events.some((event) => event.type === llmRequestStartedType)).toBe(true);
      expect(events.some((event) => event.type === llmRequestCanceledType)).toBe(true);
      expect(events.some((event) => event.type === codemodeBlockAddedType)).toBe(true);
      expect(events.some((event) => event.type === llmRequestCompletedType)).toBe(true);
    } finally {
      await runtime.stopAndWait();
    }
  }, 90_000);

  test("can message another agent by appending llm-input-added over fetch", async () => {
    const testName = expect.getState().currentTestName ?? "agent-to-agent";
    const senderPath = app.createTestChildStreamPath({
      childSlug: "sender",
      testName,
    });
    const receiverPath = app.createTestChildStreamPath({
      childSlug: "receiver",
      testName,
    });
    const senderRuntime = await app.startProcessors({
      processors: [
        createAgentProcessor({
          agentPath: senderPath,
          apiKey: openAiApiKey!,
          baseUrl: app.baseUrl,
          codemodeRootDirectory: path.resolve(process.cwd(), ".codemode", "tests", "sender"),
          model: openAiModel,
          projectSlug: app.projectSlug,
          workingDirectory: process.cwd(),
        }),
        createCodemodeProcessor({
          codemodeRootDirectory: path.resolve(process.cwd(), ".codemode", "tests", "sender"),
        }),
      ],
      streamPath: senderPath,
    });
    const receiverRuntime = await app.startProcessors({
      processors: [
        createAgentProcessor({
          agentPath: receiverPath,
          apiKey: openAiApiKey!,
          baseUrl: app.baseUrl,
          codemodeRootDirectory: path.resolve(process.cwd(), ".codemode", "tests", "receiver"),
          model: openAiModel,
          projectSlug: app.projectSlug,
          workingDirectory: process.cwd(),
        }),
        createCodemodeProcessor({
          codemodeRootDirectory: path.resolve(process.cwd(), ".codemode", "tests", "receiver"),
        }),
      ],
      streamPath: receiverPath,
    });

    try {
      await app.append({
        path: senderPath,
        event: {
          type: llmInputAddedType,
          payload: {
            content: [
              "Write exactly one executable ```ts``` block and no prose.",
              `Use fetch to append one llm-input-added event to ${receiverPath}.`,
              'Set the payload content to: "Reply with one short sentence saying cross-agent message received."',
              "Set payload.source to user.",
              "After the POST succeeds, log a JSON object with the target path and response status.",
            ].join(" "),
            source: "user",
          },
        },
      });

      const senderResultEvent = await app.waitForEvent({
        predicate: (event) => {
          if (event.type !== codemodeResultAddedType) {
            return false;
          }

          const parsed = CodemodeResultAddedPayload.safeParse(event.payload);
          return parsed.success && parsed.data.success;
        },
        streamPath: senderPath,
        timeoutMs: 60_000,
      });
      const receiverStartedEvent = await app.waitForEvent({
        predicate: (event) => event.type === llmRequestStartedType,
        streamPath: receiverPath,
        timeoutMs: 60_000,
      });

      const senderResult = CodemodeResultAddedPayload.parse(senderResultEvent.payload);
      const receiverEvents = await app.collectEvents(receiverPath);

      expect(senderResult.stdout).toContain(receiverPath);
      expect(receiverStartedEvent.type).toBe(llmRequestStartedType);
      expect(
        receiverEvents.some(
          (event) =>
            event.type === llmInputAddedType &&
            typeof event.payload === "object" &&
            event.payload != null &&
            "source" in event.payload &&
            event.payload.source === "user",
        ),
      ).toBe(true);
    } finally {
      await senderRuntime.stopAndWait();
      await receiverRuntime.stopAndWait();
    }
  }, 90_000);
});

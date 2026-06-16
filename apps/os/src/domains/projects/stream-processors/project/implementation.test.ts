import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";

vi.mock("~/domains/repos/entrypoints/repo-capability.ts", () => ({
  ensureProjectRepoInfoForProject: async () => ({
    defaultBranch: "main",
    slug: "project",
  }),
}));

vi.mock("~/domains/secrets/entrypoints/secrets-capability.ts", () => ({
  getSecretsCapability: () => ({
    getSecretSummaryByKeyOrNull: async () => null,
    setSecret: async () => undefined,
  }),
}));

vi.mock("~/domains/slack/durable-objects/slack-agent-durable-object.ts", () => ({
  getSlackAgentDurableObjectName: (input: { projectId: string; streamPath: string }) =>
    `${input.projectId}:${input.streamPath}`,
}));

import { SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE } from "~/domains/agents/agent-prompt-guidance.ts";
import { projectOnboardingBootstrapMarkdown } from "~/domains/repos/project-repo-template.ts";
import { ProjectProcessor, defaultAgentSystemPrompt } from "./implementation.ts";

describe("project agent prompts", () => {
  it("tells web agents to await chat sends without returning side-effect results", () => {
    const prompt = defaultAgentSystemPrompt("/agents/onboarding");

    expect(prompt).toContain("await itx.chat.sendMessage({ message })");
    expect(prompt).toContain(SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE);
    expect(prompt).not.toContain("return await itx.chat.sendMessage");
  });

  it("tells slack agents to await replies without returning side-effect results", () => {
    const prompt = defaultAgentSystemPrompt("/agents/slack/C123/ts-456");

    expect(prompt).toContain("await itx.slack.chat.postMessage");
    expect(prompt).toContain(SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE);
    expect(prompt).not.toContain("return await itx.slack.chat.postMessage");
  });

  it("onboarding bootstrap tells agents not to return chat-send results by default", () => {
    const markdown = projectOnboardingBootstrapMarkdown({
      projectId: "prj_test",
      slug: "test-project",
    });

    expect(markdown).toContain("awaiting `itx.chat.sendMessage({ message })`");
    expect(markdown).toContain("Do not\n  return the result");
    expect(markdown).not.toContain("return await itx.chat.sendMessage");
  });
});

describe("ProjectProcessor worker forwarding", () => {
  it("forwards project worker-visible root-stream events after project identity exists", async () => {
    const forwarded: string[] = [];
    const processor = newProcessor({
      forwardToProjectWorker: async (event) => {
        forwarded.push(`${event.offset}:${event.type}`);
      },
    });

    await processor.ingest({
      events: [
        event({ offset: 3, type: "events.iterate.com/stream/subscription-configured" }),
        projectCreated(4),
      ],
      streamMaxOffset: 4,
    });
    await processor.ingest({
      events: [event({ offset: 5, type: "another.custom/event" })],
      streamMaxOffset: 5,
    });

    expect(forwarded).toEqual(["4:events.iterate.com/project/created", "5:another.custom/event"]);
  });

  it("does not forward pre-creation stream bookkeeping", async () => {
    const forwarded: string[] = [];
    const processor = newProcessor({
      forwardToProjectWorker: async (event) => {
        forwarded.push(`${event.offset}:${event.type}`);
      },
    });

    await processor.ingest({
      events: [
        event({ offset: 3, type: "events.iterate.com/stream/subscription-configured" }),
        event({ offset: 4, type: "events.iterate.com/stream/subscriber-connected" }),
      ],
      streamMaxOffset: 4,
    });

    expect(forwarded).toEqual([]);
    expect(processor.checkpointOffset).toBe(4);
  });

  it("does not advance the checkpoint past a failed project worker forward", async () => {
    let fail = true;
    const forwarded: number[] = [];
    const processor = newProcessor({
      forwardToProjectWorker: async (event) => {
        if (fail) throw new Error("project worker host hiccup");
        forwarded.push(event.offset);
      },
    });

    await expect(
      processor.ingest({
        events: [projectCreated(3)],
        streamMaxOffset: 3,
      }),
    ).rejects.toThrow("project worker host hiccup");
    expect(processor.checkpointOffset).toBe(0);

    fail = false;
    await processor.ingest({
      events: [projectCreated(3)],
      streamMaxOffset: 3,
    });
    expect(forwarded).toEqual([3]);
    expect(processor.checkpointOffset).toBe(3);
  });

  it("does not forward project creation requests to the project worker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const forwarded: number[] = [];
      const processor = newProcessor({
        forwardToProjectWorker: async (event) => {
          forwarded.push(event.offset);
        },
      });

      await processor.ingest({
        events: [
          event({
            offset: 3,
            payload: { projectId: "another_project", slug: "another-project" },
            type: "events.iterate.com/project/create-requested",
          }),
        ],
        streamMaxOffset: 3,
      });

      expect(forwarded).toEqual([]);
      expect(processor.checkpointOffset).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });
});

function newProcessor(deps: { forwardToProjectWorker: (event: StreamEvent) => Promise<void> }) {
  return new ProjectProcessor({
    appConfig: () => ({ projectHostnameBases: ["iterate.localhost"] }) as never,
    env: {} as never,
    exports: {},
    iterateContext: { stream: { append: () => {}, appendBatch: () => {} } },
    projectId: () => "project_1",
    ...deps,
  });
}

function event(args: { offset: number; payload?: unknown; type: string }): StreamEvent {
  return {
    type: args.type,
    payload: args.payload ?? {},
    offset: args.offset,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function projectCreated(offset: number): StreamEvent {
  return event({
    offset,
    payload: {
      defaultHost: "project.iterate.localhost",
      hosts: ["project.iterate.localhost"],
      projectId: "project_1",
      slug: "project",
    },
    type: "events.iterate.com/project/created",
  });
}

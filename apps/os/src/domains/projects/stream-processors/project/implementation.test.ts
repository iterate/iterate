import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-event";

vi.mock("~/domains/repos/entrypoints/repo-capability.ts", () => ({
  ensureProjectRepoInfoForProject: async () => ({
    defaultBranch: "main",
    path: "/repos/project",
  }),
}));

vi.mock("~/domains/slack/durable-objects/slack-agent-durable-object.ts", () => ({
  getSlackAgentDurableObjectName: (input: { path: string; projectId: string }) =>
    `${input.projectId}:${input.path}`,
}));

import { ProjectProcessor, defaultAgentSystemPrompt } from "./implementation.ts";
import { SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE } from "~/domains/agents/agent-prompt-guidance.ts";

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

  it("indexes child repo, agent, and workspace streams in reduced state", async () => {
    const processor = newProcessor({ forwardToProjectWorker: async () => undefined });

    await processor.ingest({
      events: [
        childStreamCreated({
          childPath: "/repos/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          offset: 3,
        }),
        childStreamCreated({
          childPath: "/agents/onboarding",
          createdAt: "2026-01-01T00:00:01.000Z",
          offset: 4,
        }),
        childStreamCreated({
          childPath: "/workspaces/project",
          createdAt: "2026-01-01T00:00:02.000Z",
          offset: 5,
        }),
        childStreamCreated({
          childPath: "/repos/project",
          createdAt: "2026-01-01T00:00:03.000Z",
          offset: 6,
        }),
      ],
      streamMaxOffset: 6,
    });

    await expect(processor.snapshot()).resolves.toMatchObject({
      state: {
        agents: [{ createdAt: "2026-01-01T00:00:01.000Z", path: "/agents/onboarding" }],
        repos: [{ createdAt: "2026-01-01T00:00:00.000Z", path: "/repos/project" }],
        workspaces: [{ createdAt: "2026-01-01T00:00:02.000Z", path: "/workspaces/project" }],
      },
    });
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

function event(args: {
  createdAt?: string;
  offset: number;
  payload?: unknown;
  type: string;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload ?? {},
    offset: args.offset,
    createdAt: args.createdAt ?? "2026-01-01T00:00:00.000Z",
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

function childStreamCreated(input: {
  childPath: string;
  createdAt: string;
  offset: number;
}): StreamEvent {
  return event({
    createdAt: input.createdAt,
    offset: input.offset,
    payload: { childPath: input.childPath },
    type: "events.iterate.com/stream/child-stream-created",
  });
}

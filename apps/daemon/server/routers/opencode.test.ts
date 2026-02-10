import { describe, it, expect } from "vitest";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import { agentStatusFromOpencodeEvent } from "./opencode.ts";

const SESSION_ID = "test-session";
const MESSAGE_ID = "test-message";

function toolPart(overrides: { tool?: string; state: Record<string, unknown> }): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-1",
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        type: "tool",
        callID: "call-1",
        tool: overrides.tool ?? "bash",
        state: overrides.state,
      },
    },
  } as OpencodeEvent;
}

describe("agentStatusFromOpencodeEvent", () => {
  it("returns not working for session.idle", () => {
    const event: OpencodeEvent = {
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    };
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: false,
      shortStatus: "",
    });
  });

  it("returns not working for session.error", () => {
    const event: OpencodeEvent = {
      type: "session.error",
      properties: { sessionID: SESSION_ID },
    };
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: false,
      shortStatus: "",
    });
  });

  it("returns not working for session.status with idle type", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    };
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: false,
      shortStatus: "",
    });
  });

  it("returns null for session.status with busy type", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "busy" } },
    };
    expect(agentStatusFromOpencodeEvent(event)).toBeNull();
  });

  it("returns working with title for running tool", () => {
    const event = toolPart({
      tool: "bash",
      state: {
        status: "running",
        title: "Running tests",
        input: {},
        time: { start: 1 },
      },
    });
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: true,
      shortStatus: "Running tests",
    });
  });

  it("returns working with title for completed tool", () => {
    const event = toolPart({
      tool: "read",
      state: {
        status: "completed",
        title: "Read file",
        input: {},
        output: "contents",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: true,
      shortStatus: "Read file",
    });
  });

  it("falls back to input.description when title is missing", () => {
    const event = toolPart({
      tool: "bash",
      state: {
        status: "running",
        input: { description: "pnpm test" },
        time: { start: 1 },
      },
    });
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: true,
      shortStatus: "pnpm test",
    });
  });

  it("falls back to tool name when title and description are missing", () => {
    const event = toolPart({
      tool: "glob",
      state: { status: "running", input: {}, time: { start: 1 } },
    });
    expect(agentStatusFromOpencodeEvent(event)).toEqual({
      isWorking: true,
      shortStatus: "glob",
    });
  });

  it("truncates long status to 30 chars", () => {
    const event = toolPart({
      tool: "bash",
      state: {
        status: "running",
        title: "This is a very long tool title that should be truncated",
        input: {},
        time: { start: 1 },
      },
    });
    const result = agentStatusFromOpencodeEvent(event);
    expect(result?.shortStatus.length).toBe(30);
  });

  it("returns null for pending tool state", () => {
    const event = toolPart({
      state: { status: "pending", input: {}, raw: "" },
    });
    expect(agentStatusFromOpencodeEvent(event)).toBeNull();
  });

  it("returns null for irrelevant events", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          mode: "normal",
          modelID: "test",
          providerID: "test",
          parentID: "",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    };
    expect(agentStatusFromOpencodeEvent(event)).toBeNull();
  });
});

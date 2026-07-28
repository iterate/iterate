import { describe, expect, test, vi } from "vitest";
import { newWebAgentPath, sendAgentFirstTurn } from "./web-agent.ts";

function fakeFile(name: string, size: number, type = "text/plain"): File {
  return new File([new Uint8Array(size)], name, { type });
}

function fakeAgent() {
  return {
    create: vi.fn(async () => undefined),
    message: vi.fn(async () => undefined),
    addFiles: vi.fn(async (_input: { files: unknown[]; message?: string }) => undefined),
  };
}

test("newWebAgentPath is a stable slug of the creation time", () => {
  expect(newWebAgentPath(new Date("2026-07-17T12:34:56.789Z"))).toBe(
    "/agents/web/2026-07-17t12-34-56-789z",
  );
});

describe("sendAgentFirstTurn", () => {
  test("text-only: create then message, trimmed", async () => {
    const agent = fakeAgent();
    await sendAgentFirstTurn(agent, { message: "  hello  " });
    expect(agent.create).toHaveBeenCalledOnce();
    expect(agent.message).toHaveBeenCalledWith("hello");
    expect(agent.addFiles).not.toHaveBeenCalled();
  });

  test("with files: one addFiles call carrying message and encoded files", async () => {
    const agent = fakeAgent();
    await sendAgentFirstTurn(agent, { message: "with file", files: [fakeFile("note.txt", 4)] });
    expect(agent.create).toHaveBeenCalledOnce();
    expect(agent.message).not.toHaveBeenCalled();
    expect(agent.addFiles).toHaveBeenCalledOnce();
    const payload = agent.addFiles.mock.calls[0]![0] as {
      message?: string;
      files: { filename: string; contentType: string; data: Uint8Array }[];
    };
    expect(payload.message).toBe("with file");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.filename).toBe("note.txt");
    expect(payload.files[0]!.contentType).toBe("text/plain");
    expect(payload.files[0]!.data).toBeInstanceOf(Uint8Array);
  });

  test("files-only first turn omits the empty message", async () => {
    const agent = fakeAgent();
    await sendAgentFirstTurn(agent, {
      message: "   ",
      files: [fakeFile("pic.png", 8, "image/png")],
    });
    expect(agent.addFiles).toHaveBeenCalledOnce();
    expect(agent.addFiles.mock.calls[0]![0]).not.toHaveProperty("message");
    expect(agent.message).not.toHaveBeenCalled();
  });
});

import { describe, expect, test, vi } from "vitest";
import {
  createAgentWithFirstTurn,
  fileSizeErrorMessage,
  formatFileSize,
  MAX_MESSAGE_FILE_SIZE_BYTES,
  newWebAgentPath,
  partitionFilesBySize,
  slugifyCreationTime,
} from "./composer-files.ts";

function fakeFile(name: string, size: number, type = "text/plain"): File {
  // File constructor size comes from the blob parts; pad with a fixed byte.
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

describe("composer file helpers", () => {
  test("formatFileSize uses B / KB / MB", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1 MB");
  });

  test("partitionFilesBySize splits accepted and rejected", () => {
    const small = fakeFile("ok.txt", 10);
    const large = fakeFile("big.bin", MAX_MESSAGE_FILE_SIZE_BYTES + 1);
    const result = partitionFilesBySize([small, large]);
    expect(result.accepted).toEqual([small]);
    expect(result.rejected).toEqual([large]);
  });

  test("fileSizeErrorMessage names one file or a count", () => {
    expect(fileSizeErrorMessage([])).toBeUndefined();
    expect(fileSizeErrorMessage([fakeFile("photo.png", MAX_MESSAGE_FILE_SIZE_BYTES + 1)])).toBe(
      `photo.png must be ${formatFileSize(MAX_MESSAGE_FILE_SIZE_BYTES)} or smaller.`,
    );
    expect(
      fileSizeErrorMessage([
        fakeFile("a.bin", MAX_MESSAGE_FILE_SIZE_BYTES + 1),
        fakeFile("b.bin", MAX_MESSAGE_FILE_SIZE_BYTES + 1),
      ]),
    ).toBe(`2 files must be ${formatFileSize(MAX_MESSAGE_FILE_SIZE_BYTES)} or smaller.`);
  });

  test("slugifyCreationTime and newWebAgentPath are stable web agent paths", () => {
    const date = new Date("2026-07-17T12:34:56.789Z");
    expect(slugifyCreationTime(date)).toBe("2026-07-17t12-34-56-789z");
    expect(newWebAgentPath(date)).toBe("/agents/web/2026-07-17t12-34-56-789z");
  });
});

describe("createAgentWithFirstTurn", () => {
  test("text-only create then message", async () => {
    const create = vi.fn(async () => undefined);
    const message = vi.fn(async () => undefined);
    const addFiles = vi.fn(async () => undefined);
    const connectItx = vi.fn(async () => ({
      agents: { get: () => ({ create, message, addFiles }) },
    }));

    const path = await createAgentWithFirstTurn({
      projectId: "prj_test",
      connectItx,
      message: "  hello  ",
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(path).toBe("/agents/web/2026-07-17t00-00-00-000z");
    expect(connectItx).toHaveBeenCalledWith("prj_test");
    expect(create).toHaveBeenCalledOnce();
    expect(message).toHaveBeenCalledWith("hello");
    expect(addFiles).not.toHaveBeenCalled();
  });

  test("create with files uses addFiles (same as chat composer)", async () => {
    const create = vi.fn(async () => undefined);
    const message = vi.fn(async () => undefined);
    const addFilesCalls: unknown[] = [];
    const addFiles = vi.fn(async (input: unknown) => {
      addFilesCalls.push(input);
    });
    const connectItx = vi.fn(async () => ({
      agents: { get: () => ({ create, message, addFiles }) },
    }));
    const file = fakeFile("note.txt", 4, "text/plain");

    await createAgentWithFirstTurn({
      projectId: "prj_test",
      connectItx,
      message: "with file",
      files: [file],
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(create).toHaveBeenCalledOnce();
    expect(message).not.toHaveBeenCalled();
    expect(addFiles).toHaveBeenCalledOnce();
    const payload = addFilesCalls[0] as {
      message?: string;
      files: { filename: string; contentType: string; data: Uint8Array }[];
    };
    expect(payload.message).toBe("with file");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.filename).toBe("note.txt");
    expect(payload.files[0]!.contentType).toBe("text/plain");
    expect(payload.files[0]!.data).toBeInstanceOf(Uint8Array);
  });

  test("files-only first turn omits empty message", async () => {
    const create = vi.fn(async () => undefined);
    const message = vi.fn(async () => undefined);
    const addFilesCalls: unknown[] = [];
    const addFiles = vi.fn(async (input: unknown) => {
      addFilesCalls.push(input);
    });
    const connectItx = vi.fn(async () => ({
      agents: { get: () => ({ create, message, addFiles }) },
    }));

    await createAgentWithFirstTurn({
      projectId: "prj_test",
      connectItx,
      message: "   ",
      files: [fakeFile("pic.png", 8, "image/png")],
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(addFiles).toHaveBeenCalledOnce();
    expect(addFilesCalls[0]).not.toHaveProperty("message");
    expect(message).not.toHaveBeenCalled();
  });
});

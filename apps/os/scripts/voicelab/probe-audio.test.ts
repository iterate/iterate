import { describe, expect, test, vi } from "vitest";

import { connectProject } from "./connect.ts";
import { hasAudibleSignal, openStream, type StreamHandle } from "./probe-audio.ts";

vi.mock("./connect.ts", () => ({ connectProject: vi.fn() }));

describe("openStream", () => {
  test("releases its stream and owning project session exactly once", async () => {
    const disposeStream = vi.fn();
    const disposeProject = vi.fn();
    /* This fixture exercises only StreamHandle's ownership boundary; no test
     * path invokes append/openConnection, so the narrow mock is sufficient. */
    const stream = {
      [Symbol.dispose]: disposeStream,
      append: vi.fn(),
      openConnection: vi.fn(),
    } as unknown as StreamHandle;
    const project = {
      [Symbol.dispose]: disposeProject,
      streams: { get: vi.fn(() => stream) },
    };
    /* Vitest erases connectProject's Cap'n Web generic; this mock supplies the
     * only member openStream reads and is never exposed outside this fixture. */
    vi.mocked(connectProject).mockResolvedValue(project as never);

    const opened = await openStream({ project: "proof", streamPath: "/voice" });
    opened.close();
    opened.close();

    expect(project.streams.get).toHaveBeenCalledWith("/voice");
    expect(disposeStream).toHaveBeenCalledTimes(1);
    expect(disposeProject).toHaveBeenCalledTimes(1);
  });
});

test("uses the voice output threshold for direct and stream PCM metrics", () => {
  const quiet = Buffer.alloc(2);
  quiet.writeInt16LE(99);
  const speech = Buffer.alloc(2);
  speech.writeInt16LE(100);

  expect(hasAudibleSignal(quiet)).toBe(false);
  expect(hasAudibleSignal(speech)).toBe(true);
});

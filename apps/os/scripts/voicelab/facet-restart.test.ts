import { describe, expect, it, vi } from "vitest";

import { restartStreamHostedVoiceFacet } from "./facet-restart.ts";

describe("restartStreamHostedVoiceFacet", () => {
  it("kills the parent stream, including its hosted userspace facet", async () => {
    const kill = vi.fn(async () => {
      throw new Error("kill requested");
    });
    const dispose = vi.fn();
    const get = vi.fn(() => ({ kill, [Symbol.dispose]: dispose }));

    await expect(
      restartStreamHostedVoiceFacet({ streams: { get } }, "/agents/voice/test"),
    ).resolves.toBe(undefined);

    expect(get).toHaveBeenCalledWith("/agents/voice/test");
    expect(kill).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports an unconfirmed restart and still releases the stream", async () => {
    const error = new Error("connection closed before kill reached the stream");
    const dispose = vi.fn();
    const get = () => ({
      kill: async () => {
        throw error;
      },
      [Symbol.dispose]: dispose,
    });

    await expect(
      restartStreamHostedVoiceFacet({ streams: { get } }, "/agents/voice/test"),
    ).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

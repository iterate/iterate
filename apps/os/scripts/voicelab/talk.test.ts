import { describe, expect, it } from "vitest";

import { assertReuseConfigOptions, refuseSilentPostureFlip } from "./talk.ts";

describe("talk reuse-config", () => {
  it("requires a named stream before opening a project connection", () => {
    expect(() => assertReuseConfigOptions({ reuseConfig: true })).toThrow(
      "--reuse-config requires an explicit --stream-path",
    );
  });

  it("cannot mask a posture mismatch with a flip", async () => {
    const itx = {
      streams: {
        get: () => ({
          getEvents: async () => [{ offset: 1, payload: { clientTakesTurns: false } }],
        }),
      },
    };
    await expect(
      refuseSilentPostureFlip(itx, "/boards/satellite", {
        intendedClientTakesTurns: true,
        flipTurnPosture: false,
      }),
    ).rejects.toThrow("refusing to reinstall /boards/satellite");
  });

  it("refuses to reuse a stream that has never been configured", async () => {
    const itx = { streams: { get: () => ({ getEvents: async () => [] }) } };
    await expect(
      refuseSilentPostureFlip(itx, "/boards/missing", {
        intendedClientTakesTurns: false,
        flipTurnPosture: false,
        requireConfigured: true,
      }),
    ).rejects.toThrow("--reuse-config requires an existing voice-agent configuration");
  });
});

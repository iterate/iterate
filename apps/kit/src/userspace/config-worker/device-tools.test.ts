import { describe, expect, test, vi } from "vitest";
import { executeKitDeviceTool, executeM5StickS3Tool } from "./device-tools.ts";

describe("M5StickS3 userspace device tools", () => {
  test("uses the authenticated device slug rather than a Stick-only worker fork", async () => {
    const invokeCapability = vi.fn(async () => true);
    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        {
          arguments: '{"spriteSet":"karakuri-brass"}',
          callId: "call_stackchan",
          name: "changeSpriteSet",
        },
        "stackchan",
      ),
    ).resolves.toEqual({ ok: true, spriteSet: "karakuri-brass" });
    expect(invokeCapability).toHaveBeenCalledWith({
      args: ["karakuri-brass"],
      path: ["kit", "stackchan", "changeSpriteSet"],
    });
  });
  test("routes Grok's validated sprite choice through the project-root env.ITX capability", async () => {
    /*
     * The voice provider must not learn a second device protocol. This fake is
     * the exact project-root capability-host boundary supplied by env.ITX; the
     * assertion protects the mounted path and scalar C-call shape used by the
     * production worker.
     */
    const invokeCapability = vi.fn(async () => true);
    const get = vi.fn(() => ({ invokeCapability }));

    await expect(
      executeM5StickS3Tool(
        { capabilityHosts: { get } },
        {
          arguments: '{"spriteSet":"starbyte"}',
          callId: "call_starbyte",
          name: "changeSpriteSet",
        },
      ),
    ).resolves.toEqual({ ok: true, spriteSet: "starbyte" });
    expect(get).toHaveBeenCalledWith("/");
    expect(invokeCapability).toHaveBeenCalledWith({
      args: ["starbyte"],
      path: ["kit", "m5sticks3", "changeSpriteSet"],
    });
  });

  test.each([
    ["unknown tool", { arguments: '{"spriteSet":"starbyte"}', callId: "call", name: "erase" }],
    ["invalid JSON", { arguments: "starbyte", callId: "call", name: "changeSpriteSet" }],
    [
      "unsupported sprite set",
      { arguments: '{"spriteSet":"unknown"}', callId: "call", name: "changeSpriteSet" },
    ],
    [
      "extra authority",
      {
        arguments: '{"spriteSet":"starbyte","path":["secrets"]}',
        callId: "call",
        name: "changeSpriteSet",
      },
    ],
  ])("rejects %s without invoking the device", async (_scenario, call) => {
    /*
     * Tool arguments are untrusted model output. Accepting extra fields or a
     * dynamic path would turn a closed sprite selector into ambient project
     * authority, so the worker validates an exact closed object before ITX.
     */
    const invokeCapability = vi.fn(async () => true);
    await expect(
      executeM5StickS3Tool({ capabilityHosts: { get: () => ({ invokeCapability }) } }, call),
    ).rejects.toThrow();
    expect(invokeCapability).not.toHaveBeenCalled();
  });

  test("rejects a false device acknowledgement instead of reporting a visual change", async () => {
    /*
     * Grok's spoken confirmation is user-visible evidence. A falsy capability
     * result cannot be converted into success merely because the RPC itself
     * resolved; doing so would make the voice and physical screen disagree.
     */
    await expect(
      executeM5StickS3Tool(
        {
          capabilityHosts: {
            get: () => ({ invokeCapability: async () => false }),
          },
        },
        {
          arguments: '{"spriteSet":"starbyte"}',
          callId: "call_starbyte",
          name: "changeSpriteSet",
        },
      ),
    ).rejects.toThrow("did not acknowledge");
  });

  test("hangs up through the authenticated conversation capability", async () => {
    const invokeCapability = vi.fn(async () => true);
    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        { arguments: "{}", callId: "call_end", name: "endConversation" },
        "stackchan",
      ),
    ).resolves.toEqual({ action: "conversation-ended", ok: true });
    expect(invokeCapability).toHaveBeenCalledWith({
      args: [],
      path: ["kit", "stackchan", "conversation", "hangUp"],
    });
  });

  test("turns a nod into two acknowledged safe poses without device-side queuing", async () => {
    const invokeCapability = vi.fn(async (_call: { args: unknown[]; path: string[] }) => true);
    const delay = vi.fn(async () => undefined);
    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        { arguments: "{}", callId: "call_nod", name: "nod" },
        "stackchan",
        { delay },
      ),
    ).resolves.toEqual({ action: "nodded", ok: true });
    expect(invokeCapability.mock.calls.map(([call]) => call)).toEqual([
      {
        args: [{ pitchDegrees: 25, speed: 220, yawDegrees: 0 }],
        path: ["kit", "stackchan", "servos", "move"],
      },
      {
        args: [{ pitchDegrees: 0, speed: 220, yawDegrees: 0 }],
        path: ["kit", "stackchan", "servos", "move"],
      },
    ]);
    expect(delay).toHaveBeenCalledExactlyOnceWith(250);
  });

  test("returns a head shake to neutral and rejects gestures on non-servo devices", async () => {
    const invokeCapability = vi.fn(async (_call: { args: unknown[]; path: string[] }) => true);
    const delay = vi.fn(async () => undefined);
    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        { arguments: "{}", callId: "call_shake", name: "shakeHead" },
        "stackchan",
        { delay },
      ),
    ).resolves.toEqual({ action: "shook-head", ok: true });
    expect(invokeCapability.mock.calls.map(([call]) => call.args[0])).toEqual([
      { pitchDegrees: 0, speed: 220, yawDegrees: -25 },
      { pitchDegrees: 0, speed: 220, yawDegrees: 25 },
      { pitchDegrees: 0, speed: 220, yawDegrees: 0 },
    ]);
    expect(delay).toHaveBeenCalledTimes(2);

    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        { arguments: "{}", callId: "call_bad", name: "nod" },
        "m5sticks3",
      ),
    ).rejects.toThrow("only available on StackChan");
  });

  test("rejects generated fields on argument-free physical tools", async () => {
    const invokeCapability = vi.fn(async () => true);
    await expect(
      executeKitDeviceTool(
        { capabilityHosts: { get: () => ({ invokeCapability }) } },
        {
          arguments: '{"yawDegrees":128}',
          callId: "call_injected",
          name: "shakeHead",
        },
        "stackchan",
      ),
    ).rejects.toThrow("closed schema");
    expect(invokeCapability).not.toHaveBeenCalled();
  });
});

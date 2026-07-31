import { describe, expect, test, vi } from "vitest";
import { executeM5StickS3Tool } from "./device-tools.ts";

describe("M5StickS3 userspace device tools", () => {
  test("routes Grok's validated colour choice through the project-root env.ITX capability", async () => {
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
          arguments: '{"colour":"green"}',
          callId: "call_green",
          name: "changeColour",
        },
      ),
    ).resolves.toEqual({ colour: "green", ok: true });
    expect(get).toHaveBeenCalledWith("/");
    expect(invokeCapability).toHaveBeenCalledWith({
      args: ["green"],
      path: ["kit", "m5sticks3", "changeColour"],
    });
  });

  test.each([
    ["unknown tool", { arguments: '{"colour":"red"}', callId: "call", name: "erase" }],
    ["invalid JSON", { arguments: "red", callId: "call", name: "changeColour" }],
    [
      "unsupported colour",
      { arguments: '{"colour":"blue"}', callId: "call", name: "changeColour" },
    ],
    [
      "extra authority",
      {
        arguments: '{"colour":"red","path":["secrets"]}',
        callId: "call",
        name: "changeColour",
      },
    ],
  ])("rejects %s without invoking the device", async (_scenario, call) => {
    /*
     * Tool arguments are untrusted model output. Accepting extra fields or a
     * dynamic path would turn a two-colour display tool into ambient project
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
          arguments: '{"colour":"red"}',
          callId: "call_red",
          name: "changeColour",
        },
      ),
    ).rejects.toThrow("did not acknowledge");
  });
});

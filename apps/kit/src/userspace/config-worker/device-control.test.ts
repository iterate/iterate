import { describe, expect, test, vi } from "vitest";
import { interruptKitDevicePlayback } from "./device-control.ts";

describe("kit device control", () => {
  test("accepts fresh provider audio only after the mounted device acknowledges playback reset", async () => {
    /*
     * Server VAD can announce speech after userspace has already admitted old
     * response samples toward the speaker. The acknowledgement is therefore a
     * media-safety boundary, not a best-effort UI command: this public ITX call
     * must address the authenticated device and reject every result except the
     * literal acknowledgement implemented by the C peer.
     */
    const invokeCapability = vi.fn(async () => true as unknown);
    const project = { capabilityHosts: { get: vi.fn(() => ({ invokeCapability })) } };

    await expect(interruptKitDevicePlayback(project, "stackchan")).resolves.toBeUndefined();
    expect(project.capabilityHosts.get).toHaveBeenCalledWith("/");
    expect(invokeCapability).toHaveBeenCalledWith({
      args: [],
      path: ["kit", "stackchan", "conversation", "interruptPlayback"],
    });

    await expect(
      interruptKitDevicePlayback(project, "home-assistant-voice-preview-edition"),
    ).resolves.toBeUndefined();
    expect(invokeCapability).toHaveBeenLastCalledWith({
      args: [],
      path: ["kit", "homeAssistantVoicePreviewEdition", "conversation", "interruptPlayback"],
    });

    invokeCapability.mockResolvedValueOnce(false);
    await expect(interruptKitDevicePlayback(project, "stackchan")).rejects.toThrow(
      "did not acknowledge the playback interruption",
    );
  });
});

import { describe, expect, test } from "vitest";
import { kitDeviceCapabilityPath, kitDeviceCapabilitySegment } from "./device-id.ts";

describe("kit device identity", () => {
  test("maps a URL-safe device slug to the JavaScript-safe ITX member mounted by firmware", () => {
    /*
     * PCM headers and evidence streams deliberately use stable kebab-case
     * slugs, while OS capability paths accept JavaScript identifiers. HAVPE
     * exposed the real incompatibility: using one spelling for both made its
     * authenticated provideCapability call fail only in production. These
     * literals independently pin the wire-name translation shared with the C
     * target; a later worker refactor must not address a different device.
     */
    expect(kitDeviceCapabilitySegment("stackchan")).toBe("stackchan");
    expect(kitDeviceCapabilitySegment("home-assistant-voice-preview-edition")).toBe(
      "homeAssistantVoicePreviewEdition",
    );
    expect(
      kitDeviceCapabilityPath(
        "home-assistant-voice-preview-edition",
        "conversation",
        "interruptPlayback",
      ),
    ).toEqual(["kit", "homeAssistantVoicePreviewEdition", "conversation", "interruptPlayback"]);
  });
});

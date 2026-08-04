import { describe, expect, test } from "vitest";
import {
  productionGrokDeviceToolPrompt,
  PRODUCTION_GROK_DEVICE_TOOL_SPRITE_SET,
  productionGrokTurnRequiresDeviceTool,
  requiredDeviceToolCallsForVoiceProof,
} from "./production-grok-turn-policy.ts";

describe("production Grok turn policy", () => {
  test("proves the device tool once without turning ordinary conversation into repeated sprite tests", () => {
    /*
     * The physical harness used to demand a display mutation on every turn. Grok
     * correctly produced spoken audio on a later turn but chose not to repeat
     * the mutation, so a healthy multi-turn PCM session waited 90 seconds and
     * failed. The landing contract needs both facts independently: the tool is
     * real, and subsequent utterances remain conversational on the same socket.
     */
    expect(productionGrokTurnRequiresDeviceTool(1)).toBe(true);
    expect(productionGrokTurnRequiresDeviceTool(2)).toBe(false);
    expect(productionGrokTurnRequiresDeviceTool(20)).toBe(false);
    expect(requiredDeviceToolCallsForVoiceProof(1)).toBe(1);
    expect(requiredDeviceToolCallsForVoiceProof(20)).toBe(1);
  });

  test("does not impose the sprite scenario on an explicit audio-stress prompt", () => {
    /*
     * A long-story run exists to hold the exact production downlink open long
     * enough to expose reservoir, pacing, and device-buffer failures. Tying
     * that independent scenario to turn one's sprite-tool assertion made a
     * completely played 68-second response wait out the 90-second watchdog
     * merely because a story quite correctly did not change the display.
     */
    const longStoryPrompt = "Tell me a detailed story lasting about one minute.";
    expect(productionGrokTurnRequiresDeviceTool(1, longStoryPrompt)).toBe(false);
    expect(requiredDeviceToolCallsForVoiceProof(1, longStoryPrompt)).toBe(0);
  });

  test("speaks an unambiguous public face name instead of the compact API slug", () => {
    /*
     * macOS pronounced `starbyte` as something xAI successively transcribed as
     * “starlight” and “starbite”. Grok then quite correctly refused to invent
     * an enum value that its own transcript did not name, while the old harness
     * hid that provider decision behind a 90-second “playback boundary” timeout.
     * Karakuri Brass is a naturally spoken, supported name and the prompt
     * separately tells the model to use the tool; the tool schema remains the
     * authority for translating that name to its stable slug.
     */
    expect(PRODUCTION_GROK_DEVICE_TOOL_SPRITE_SET).toBe("karakuri-brass");
    expect(productionGrokDeviceToolPrompt()).toBe(
      "Change the face to Karakuri Brass. Call the change sprite set tool before speaking. " +
        "Do not say a preamble. " +
        "After the tool succeeds, say exactly: The brass face is active and the zebra is awake.",
    );
    expect(productionGrokDeviceToolPrompt(true)).toMatch(/Release Button A now\.$/);
    expect(productionGrokDeviceToolPrompt()).not.toContain("karakuri-brass");
  });

  test("rejects invalid turn counts instead of silently weakening the proof", () => {
    expect(() => productionGrokTurnRequiresDeviceTool(0)).toThrow("positive integer");
    expect(() => requiredDeviceToolCallsForVoiceProof(0)).toThrow("at least one turn");
  });
});

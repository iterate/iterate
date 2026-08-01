import { describe, expect, test } from "vitest";
import {
  productionGrokTurnRequiresDeviceTool,
  requiredDeviceToolCallsForVoiceProof,
} from "./production-grok-turn-policy.ts";

describe("production Grok turn policy", () => {
  test("proves the device tool once without turning ordinary conversation into repeated colour tests", () => {
    /*
     * The physical harness used to demand changeColour on every turn. Grok
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

  test("rejects invalid turn counts instead of silently weakening the proof", () => {
    expect(() => productionGrokTurnRequiresDeviceTool(0)).toThrow("positive integer");
    expect(() => requiredDeviceToolCallsForVoiceProof(0)).toThrow("at least one turn");
  });
});

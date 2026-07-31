import { describe, expect, test } from "vitest";
import {
  observeAutonomousVoiceFrameTiming,
  type AutonomousVoiceTurnTiming,
} from "./autonomous-voice-timing.ts";

describe("autonomous voice timing", () => {
  test("does not attribute stale interrupted speech to the replacement response", () => {
    /*
     * A PTT interruption changes the active microphone epoch before userspace
     * can cancel the old provider generation. Binary frames from that old
     * response may therefore cross the socket after turn 2 becomes active.
     * Treating one as turn 2's first speaker frame produced a physically
     * impossible negative stop-to-speaker latency in retained evidence.
     *
     * Provider WebSocket ordering gives us the causal fence we actually need:
     * the replacement response.created JSON precedes its binary PCM. Speaker
     * observations before that fence belong to the obsolete generation and
     * must not start the replacement-response latency clock.
     */
    const timing: AutonomousVoiceTurnTiming = { turn: 2 };

    observeAutonomousVoiceFrameTiming(timing, "speaker-downlink", 100);
    expect(timing.firstSpeakerFrameAtMonotonicMs).toBeUndefined();

    timing.providerResponseCreatedAtMonotonicMs = 150;
    observeAutonomousVoiceFrameTiming(timing, "speaker-downlink", 160);
    observeAutonomousVoiceFrameTiming(timing, "speaker-downlink", 180);

    expect(timing.firstSpeakerFrameAtMonotonicMs).toBe(160);
  });

  test("starts microphone timing immediately because capture precedes a response", () => {
    const timing: AutonomousVoiceTurnTiming = { turn: 1 };

    observeAutonomousVoiceFrameTiming(timing, "microphone-uplink", 20);
    observeAutonomousVoiceFrameTiming(timing, "microphone-uplink", 40);

    expect(timing.firstMicrophoneFrameAtMonotonicMs).toBe(20);
  });
});

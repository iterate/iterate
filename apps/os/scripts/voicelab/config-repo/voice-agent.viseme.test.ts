// The mouth's contract with the wire.
//
// The device drops any `voice-agent/viseme` event whose payload is not
// `{ callId, answer, playoutSamples, viseme, confidence }` with numbers in
// range — silently, by design. So the seam that shapes those events is tested
// with literal expectations: the exact objects that ride the outbound lane,
// not properties of them. The PCM fixture and its anchors (VAD opens at
// sample 8192; a mid-speech cut owes a SIL at the cut) are shared with
// viseme.test.ts, where they are derived.
import { describe, expect, test } from "vitest";
import { createVisemeTracker, visemeSampleRateHz, type VisemeChangeEvent } from "./viseme.ts";
import { createVisemeEmitter, type VisemeAppendEvent } from "./voice-agent.ts";

/** Appends a phase-continuous multi-tone burst to a growing signal. */
function appendTone(
  target: number[],
  seconds: number,
  frequenciesHz: number[],
  amplitude: number,
): void {
  const start = target.length;
  const count = Math.round(seconds * visemeSampleRateHz);
  for (let index = 0; index < count; index += 1) {
    let value = 0;
    for (const frequencyHz of frequenciesHz) {
      value += Math.sin((2 * Math.PI * frequencyHz * (start + index)) / visemeSampleRateHz);
    }
    target.push(Math.round((amplitude * value) / frequenciesHz.length));
  }
}

/** Appends digital silence to a growing signal. */
function appendSilence(target: number[], seconds: number): void {
  const count = Math.round(seconds * visemeSampleRateHz);
  for (let index = 0; index < count; index += 1) {
    target.push(0);
  }
}

/** viseme.test.ts's burst fixture: speech from sample 8000, VAD opens at 8192. */
function buildBurstPcm(): Int16Array {
  const signal: number[] = [];
  appendSilence(signal, 0.5);
  appendTone(signal, 0.6, [220, 440, 880], 6000);
  appendSilence(signal, 0.4);
  appendTone(signal, 0.6, [180, 1200], 6000);
  appendSilence(signal, 0.7);
  return Int16Array.from(signal);
}

/** Feeds PCM in the 20 ms frames `appendSpkPcm` cuts, collecting the events. */
function pushFrames(
  emitter: ReturnType<typeof createVisemeEmitter>,
  pcm: Int16Array,
  answer: number,
): VisemeAppendEvent[] {
  const events: VisemeAppendEvent[] = [];
  for (let offset = 0; offset < pcm.length; offset += 320) {
    events.push(...emitter.push(pcm.subarray(offset, Math.min(offset + 320, pcm.length)), answer));
  }
  return events;
}

describe("createVisemeEmitter", () => {
  // Cuts land mid-burst (speech spans samples 8000-17599) on 20 ms frame
  // boundaries, so the closing SIL's offset is exactly the samples consumed.
  test.for([
    { answer: 0, callId: "call-a", cutSamples: 12160 },
    { answer: 7, callId: "call-b", cutSamples: 9600 },
  ])(
    "ending answer $answer mid-speech appends exactly one SIL at the cut",
    ({ answer, callId, cutSamples }) => {
      const emitter = createVisemeEmitter(callId);
      const events = pushFrames(emitter, buildBurstPcm().subarray(0, cutSamples), answer);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(emitter.end(answer)).toEqual([
        {
          type: "voice-agent/viseme",
          ephemeral: true,
          payload: { callId, answer, playoutSamples: cutSamples, viseme: 14, confidence: 0 },
        },
      ]);
      // Ended twice stays closed, and audio arriving after the end is dropped
      // rather than reopening a mouth the device was told to shut.
      expect(emitter.end(answer)).toEqual([]);
      expect(emitter.push(buildBurstPcm().subarray(8000, 12000), answer)).toEqual([]);
    },
  );

  test("push stamps the call and answer onto the tracker's events, and changes nothing else", () => {
    const pcm = buildBurstPcm();
    const emitter = createVisemeEmitter("call-parity");
    const shaped = pushFrames(emitter, pcm, 3);

    const tracker = createVisemeTracker();
    const bare: VisemeChangeEvent[] = [];
    for (let offset = 0; offset < pcm.length; offset += 320) {
      bare.push(...tracker.push(pcm.subarray(offset, Math.min(offset + 320, pcm.length))));
    }
    expect(shaped).toEqual(
      bare.map((event) => ({
        type: "voice-agent/viseme",
        ephemeral: true,
        payload: {
          callId: "call-parity",
          answer: 3,
          playoutSamples: event.playoutSamples,
          viseme: event.viseme,
          confidence: event.confidence,
        },
      })),
    );
    expect(shaped.length).toBeGreaterThanOrEqual(4);
    expect(shaped[0].payload.playoutSamples).toBe(8192);
  });

  test("reset starts the next answer at zero: same audio, same offsets, new number", () => {
    const pcm = buildBurstPcm();
    const emitter = createVisemeEmitter("call-a");
    const first = pushFrames(emitter, pcm, 1);
    // The burst tail already released to SIL, so the boundary owes nothing…
    expect(emitter.end(1)).toEqual([]);
    emitter.reset();
    // …and the next answer replays identically, offsets answer-relative.
    const second = pushFrames(emitter, pcm, 2);
    expect(second).toEqual(
      first.map((event) => ({ ...event, payload: { ...event.payload, answer: 2 } })),
    );
  });

  test.for([
    { kind: "digital silence", amplitude: 0 },
    { kind: "a floor below the VAD open level", amplitude: 30 },
  ])("$kind never moves the mouth, and end owes nothing", ({ amplitude }) => {
    const quiet = Int16Array.from({ length: visemeSampleRateHz }, (_, index) =>
      Math.round(amplitude * Math.sin((2 * Math.PI * 300 * index) / visemeSampleRateHz)),
    );
    const emitter = createVisemeEmitter("call-quiet");
    expect(pushFrames(emitter, quiet, 0)).toEqual([]);
    expect(emitter.end(0)).toEqual([]);
  });
});

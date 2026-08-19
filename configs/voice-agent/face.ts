/**
 * The face: the answer's own audio classified into mouth shapes, folded into
 * ONE newest value for whatever renders a mouth.
 *
 * A PURE MECHANISM, deliberately. PCM chunks, answer boundaries and barge
 * events go IN; a face value comes OUT of `read()`; and nothing in here knows
 * about sockets, streams, dials or polls. Even the clock is the caller's:
 * every input carries its own `atMs` stamp, so the same inputs always produce
 * the same value — which is what lets face.test.ts pin the whole lifecycle
 * with no harness and no fake clock. The processor feeds it from four thin
 * call sites (the dial minting one, `response.created`, the audio delta,
 * `response.output_audio.done` and the barge) and publishes whatever `read()`
 * returns; HOW the value reaches a renderer is the transport's business, not
 * this file's.
 *
 * THE CONSUMER CONTRACT is the firmware's 10 Hz poll
 * (apps/kit/firmware/components/core/src/voicelab_stream.c,
 * `face_poll_completed`): it reads `runtime.face` off
 * `getProcessorRuntimeState({ name: "voice-agent" })`, validates
 * `answer >= 0`, `playoutSamples >= 0`, `viseme` in 0..14 and `at > 0`
 * (`confidence` alone may be omitted), and DEDUPES ON `at` — the same shape
 * at the same stamp is forwarded to the avatar zero times. That shape holds,
 * whatever the transport becomes.
 */
import { createVisemeTracker, firmwareVisemes, type VisemeChangeEvent } from "./viseme.ts";

/**
 * THE FACE IS A VALUE, NOT A STREAM: the newest mouth shape only, replaced
 * in place, which is what a 10 Hz poll wants — the latest truth, never a
 * backlog of positions the mouth has already left. Deliberately not durable:
 * after a restart the mouth should be shut, not restored to whatever shape it
 * held when the incarnation died. The firmware dedupes on `at`, so every fold
 * stamps a fresh clock.
 */
export interface FaceValue {
  /**
   * Which answer of the dial is playing, 1-based — the `answer` half of the
   * firmware's (answer, playoutSamples) coordinate, so a queued shape from a
   * dead answer can never move the mouth during the next one.
   */
  answer: number;
  /** Sample offset (16 kHz) of this shape from the answer's first sample —
   * the coordinate the firmware's viseme queue advances against played
   * audio. */
  playoutSamples: number;
  /** Firmware viseme id; SIL (14) closes the mouth. */
  viseme: number;
  /** Classification confidence 0-255; 0 for SIL. */
  confidence: number;
  /** The caller's facet clock at the fold — the firmware dedupes identical
   * polls on `at`, so the stamp is what makes a repeated shape at a new
   * moment still a new fact. */
  at: number;
}

/**
 * One face per dial, minted only when the certificate says something renders
 * one — a null face costs nothing, and on a 16 kHz-native provider the
 * classifier costs the one delta decode the identity path otherwise never
 * pays. The mouth-shape classifier inside is reset per answer: its playout
 * clock is samples from THE ANSWER's first sample, the coordinate the
 * firmware's viseme queue advances against played audio.
 */
export function createFace() {
  const tracker = createVisemeTracker();
  let answerNumber = 0;
  let newest: FaceValue | null = null;

  /** Fold the newest mouth shape into the face value, stamped with the
   * caller's clock — see {@link FaceValue.at} for why a repeat still gets a
   * fresh stamp. */
  const fold = (shape: VisemeChangeEvent, atMs: number): void => {
    newest = {
      answer: answerNumber,
      playoutSamples: shape.playoutSamples,
      viseme: shape.viseme,
      confidence: shape.confidence,
      at: atMs,
    };
  };

  return {
    /**
     * A new answer is a new mouth track: the playout clock back to zero, the
     * answer number forward, so a queued shape from the dead answer can never
     * move the mouth during this one.
     */
    answerStarted(): void {
      answerNumber += 1;
      tracker.reset();
    },

    /**
     * Classify a chunk of the answer's own 16 kHz PCM into mouth shapes and
     * keep the newest. The tracker emits sparse CHANGES; a burst answer
     * classifies far ahead of playback, and that is fine — the firmware's
     * viseme queue holds shapes by (answer, playoutSamples) and advances them
     * against audio actually played.
     */
    audio(pcm16: Uint8Array, atMs: number): void {
      const samples = new Int16Array(
        pcm16.buffer,
        pcm16.byteOffset,
        Math.floor(pcm16.byteLength / 2),
      );
      const shapes = tracker.push(samples);
      const latest = shapes.at(-1);
      if (latest !== undefined) fold(latest, atMs);
    },

    /** The mouth always closes with SIL at the end of its track. */
    answerAudioDone(atMs: number): void {
      const closing = tracker.end();
      if (closing !== undefined) fold(closing, atMs);
    },

    /**
     * A barged answer's mouth shuts NOW — the shapes still queued belong to
     * audio the clear just erased.
     */
    barge(atMs: number): void {
      tracker.reset();
      fold({ playoutSamples: 0, viseme: firmwareVisemes.SIL, confidence: 0 }, atMs);
    },

    /** The newest face value, or null before the mouth has first moved. */
    read(): FaceValue | null {
      return newest;
    },
  };
}

// The audio interface: everything the voice call needs from a microphone and a
// speaker, in wire terms (base64 PCM16 mono 16 kHz both directions — the
// protocol's only encoding), plus a per-frame level for the pulse.
//
// AN INTERFACE ON PURPOSE, with the react-native-audio-api implementation in
// voice-audio-native.ts and fakes in tests/the live e2e. The interface exists
// for a real second reason beyond testing (grill Q2): react-native-audio-api
// has an open capture issue on some physical-iOS configs (#721), and if it
// bites on-device the swap to @siteed/audio-studio is this one file's
// implementation, nothing else.

export interface VoiceMicFrame {
  /** One captured frame as the wire carries it: base64 PCM16 mono 16 kHz. */
  pcmBase64: string;
  /** UI-mapped loudness 0..1 (voice-pcm.ts pulseLevel) for the pulse. */
  level: number;
}

export interface VoiceAudioSession {
  /** Open mic + speaker; deliver capture frames until stop(). */
  start(onFrame: (frame: VoiceMicFrame) => void): Promise<void>;
  /**
   * Queue answer audio. The server paces delivery (never more than ~3s
   * ahead of the listener), so "append to the playback schedule" is the
   * entire client policy.
   */
  play(pcmBase64: string): void;
  /** `clearSpeakerBufferBeforeFrame`: throw away everything still queued —
   * the server decided the listener must not hear it (barge-in). */
  clearPlayback(): void;
  /** Route answers to the loudspeaker (hold-to-talk's default — the phone
   * is in front of you, not on your ear) or the earpiece. */
  setOutput(route: "speaker" | "earpiece"): void;
  /** Tear down mic and speaker. Idempotent. */
  stop(): Promise<void>;
}

export interface VoiceAudio {
  requestPermission(): Promise<"granted" | "denied">;
  createSession(): VoiceAudioSession;
}

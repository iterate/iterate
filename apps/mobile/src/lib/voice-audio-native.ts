// The react-native-audio-api implementation of the voice-audio seam — the
// only file that knows the native library (grill Q2: if capture issue #721
// bites on a physical device, the swap to @siteed/audio-studio replaces this
// file and nothing else).
//
// Capture: AudioRecorder's onAudioReady callback at 16 kHz mono, preferred
// 1024-sample buffers (~64 ms, grill Q5) — the ACTUAL delivered size is
// device-dependent and the protocol accepts any length, so no reslicing.
// Playback: AudioBufferQueueSourceNode, whose enqueue/clearBuffers IS the
// speaker lane's buffer policy — the server paces delivery, so appending to
// the queue is the entire client.
//
// AEC: iosMode "voiceChat" engages Apple's VoiceProcessingIO (grill Q1's
// hard requirement — an open mic on a phone speaker barges itself without
// it). defaultToSpeaker because a demo you hold in your hand should be
// audible; the earpiece fallback, if AEC disappoints, is an AVAudioSession
// port override — session-level, not library-level.
import { AudioContext, AudioManager, AudioRecorder } from "react-native-audio-api";
import type { VoiceAudio, VoiceAudioSession, VoiceMicFrame } from "./voice-audio.ts";
import { float32ToPcm16Base64, pulseLevel, VOICE_SAMPLE_RATE } from "./voice-pcm.ts";
import { pcm16Base64ToFloat32 } from "./voice-pcm.ts";

const CAPTURE_BUFFER_SAMPLES = 1024;

export function createNativeVoiceAudio(): VoiceAudio {
  return {
    requestPermission: async () => {
      const status = await AudioManager.requestRecordingPermissions();
      return status === "Granted" ? "granted" : "denied";
    },
    createSession: (): VoiceAudioSession => {
      let context: AudioContext | null = null;
      let queue: ReturnType<AudioContext["createBufferQueueSource"]> | null = null;
      let recorder: AudioRecorder | null = null;

      return {
        start: async (onFrame: (frame: VoiceMicFrame) => void) => {
          AudioManager.setAudioSessionOptions({
            iosCategory: "playAndRecord",
            iosMode: "voiceChat",
            iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
          });
          await AudioManager.setAudioSessionActivity(true);
          context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
          queue = context.createBufferQueueSource();
          queue.connect(context.destination);
          queue.start();
          recorder = new AudioRecorder();
          recorder.onAudioReady(
            {
              sampleRate: VOICE_SAMPLE_RATE,
              bufferLength: CAPTURE_BUFFER_SAMPLES,
              channelCount: 1,
            },
            ({ buffer }) => {
              const samples = buffer.getChannelData(0);
              onFrame({ pcmBase64: float32ToPcm16Base64(samples), level: pulseLevel(samples) });
            },
          );
          const started = await recorder.start();
          if (started.status === "error") {
            throw new Error(`microphone did not start: ${started.message}`);
          }
        },
        play: (pcmBase64: string) => {
          if (context === null || queue === null) return;
          const samples = pcm16Base64ToFloat32(pcmBase64);
          if (samples.length === 0) return;
          const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
          buffer.copyToChannel(samples, 0);
          queue.enqueueBuffer(buffer);
        },
        clearPlayback: () => {
          queue?.clearBuffers();
        },
        stop: async () => {
          try {
            recorder?.clearOnAudioReady();
            await recorder?.stop();
          } catch {
            /* Already stopped. */
          }
          recorder = null;
          try {
            queue?.stop();
            await context?.close();
          } catch {
            /* Already closed. */
          }
          queue = null;
          context = null;
          await AudioManager.setAudioSessionActivity(false).catch(() => {
            /* Session already inactive. */
          });
        },
      };
    },
  };
}

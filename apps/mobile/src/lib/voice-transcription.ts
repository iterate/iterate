// On-device transcription for recorded voice notes (iOS SFSpeechRecognizer
// via expo-speech-recognition). Kicked off the moment a recording lands —
// the seconds between attach and send are usually enough — and read back at
// send time, where the text rides the <voice-note transcript="…" /> part.
// Best-effort by design: permission refused, no speech, or too slow all
// resolve null and the note sends without a transcript (the agent can still
// run a model transcription on request).

import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";

const transcriptions = new Map<string, Promise<string | null>>();

/** Start transcribing the clip at `uri` in the background. */
export function beginTranscription(uri: string): void {
  if (Platform.OS === "web") return;
  transcriptions.set(
    uri,
    transcribeFile(uri).catch(() => null),
  );
}

/** The transcript for a clip, waiting at most `timeoutMs` for a still-running
 * transcription; null when there is none (never started, failed, or slow). */
export function transcriptFor(uri: string, timeoutMs: number): Promise<string | null> {
  const pending = transcriptions.get(uri);
  if (pending === undefined) return Promise.resolve(null);
  return Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function transcribeFile(uri: string): Promise<string | null> {
  // First transcription triggers the OS speech-recognition dialog (on top of
  // the mic permission the recording already asked for).
  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission.granted) return null;
  return await new Promise<string | null>((resolve) => {
    let transcript: string | null = null;
    const subscriptions: { remove: () => void }[] = [];
    const finish = (value: string | null) => {
      for (const subscription of subscriptions) subscription.remove();
      resolve(value);
    };
    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("result", (event) => {
        if (event.isFinal && event.results[0]) transcript = event.results[0].transcript;
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => finish(transcript)),
      ExpoSpeechRecognitionModule.addListener("error", () => finish(transcript)),
    );
    ExpoSpeechRecognitionModule.start({
      // The OS service (on-device on modern iPhones; iOS picks). English
      // covers the house; a wrong-language clip just resolves null-ish and
      // the model transcription path remains.
      lang: "en-US",
      addsPunctuation: true,
      interimResults: false,
      requiresOnDeviceRecognition: false,
      audioSource: { uri },
    });
  });
}

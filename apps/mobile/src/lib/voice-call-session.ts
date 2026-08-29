// The live call session — module state and the ONE way a call starts.
// Apart from the components (react-refresh wants component files exporting
// only components): the chat list, the chat header button, and the in-call
// controls all drive the same singletons, because a call outlives any
// mount.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Animated } from "react-native";
import { getProjectItx } from "./itx.ts";
import { queryClient } from "./query.ts";
import { createNativeVoiceAudio } from "./voice-audio-native.ts";
import type { VoiceAudioSession } from "./voice-audio.ts";
import { ringTonePcm16Base64 } from "./voice-pcm.ts";
import { startVoiceCall, type VoiceCallHandle } from "./voice-call.ts";
import { chatVoiceStreamPath, ensureVoiceAgentSetup } from "./voice-setup.ts";
import {
  voiceCallStatusKey as statusKey,
  voiceCallTargetKey as targetKey,
  type VoiceCallTarget,
  type VoiceUiStatus,
} from "./voice-call-state.ts";

export const voiceCallSheetKey = ["voice-call", "sheet-open"];
export const voiceCallOutputKey = ["voice-call", "output"];
const sheetKey = voiceCallSheetKey;
const outputKey = voiceCallOutputKey;

const SETUP_MARKER_STORAGE_PREFIX = "voice-setup-marker:";

let activeCall: VoiceCallHandle | null = null;
let activeSession: VoiceAudioSession | null = null;

/** The live handles, for the in-call controls (hold-to-talk, hang up,
 * output switch). Null between calls. */
export function getActiveCall(): VoiceCallHandle | null {
  return activeCall;
}
export function getActiveSession(): VoiceAudioSession | null {
  return activeSession;
}
/** Generated once, lazily (~1s of PCM as base64). */
let ringTonePcm: string | null = null;
/** Mic loudness 0..1, driven at capture-frame rate straight into the
 * animation — never through React state (16 Hz re-renders for a glow). */
export const pulse = new Animated.Value(0);

/** The one way a call starts: dial the chat at `chatPath` — its agent is
 * the backend, its thread gets the conversation, and the call UI lives on
 * its screen. Callers navigate there themselves. */
export async function startChatCall(
  baseUrl: string,
  projectId: string,
  chatPath: string,
): Promise<void> {
  const target: VoiceCallTarget = {
    baseUrl,
    projectId,
    streamPath: chatVoiceStreamPath(chatPath),
    colleaguePath: chatPath,
  };
  const audio = createNativeVoiceAudio();
  if ((await audio.requestPermission()) !== "granted") {
    const denied: VoiceUiStatus = {
      phase: "ended",
      caption: "microphone access needed — tap to open Settings",
      micDenied: true,
    };
    queryClient.setQueryData<VoiceUiStatus>(statusKey, denied);
    return;
  }
  const project = await getProjectItx(baseUrl, projectId);
  const { streamPath } = target;
  const session = audio.createSession();
  activeSession = session;
  queryClient.setQueryData<VoiceCallTarget>(targetKey, target);
  queryClient.setQueryData(sheetKey, true);
  /* Every call starts on the loudspeaker — hold-to-talk means the phone is
   * in front of you, not on your ear. */
  queryClient.setQueryData(outputKey, "speaker");
  try {
    activeCall = await startVoiceCall({
      /* `as any` (here and for workers below): the itx project handle is a
       * dynamic RPC proxy with no generated types in the app — the same
       * treatment every other mobile itx callsite gives it. */
      stream: (project as any).streams.get(streamPath),
      audio: session,
      ensureSetup: () =>
        ensureVoiceAgentSetup({
          workers: {
            get: (ref) => (project as any).workers.get(ref),
          },
          repo: (project as any).repo,
          streamPath,
          colleaguePath: target.colleaguePath,
          /* Keyed by PROJECT too, not just stream path: the path is the
           * same on every project, so a marker written against one project
           * must not convince another that its stream already has a
           * certificate (it would ring out as "no answer"). */
          readMarker: (path) =>
            AsyncStorage.getItem(`${SETUP_MARKER_STORAGE_PREFIX}${projectId}:${path}`),
          writeMarker: (path, marker) =>
            AsyncStorage.setItem(`${SETUP_MARKER_STORAGE_PREFIX}${projectId}:${path}`, marker),
        }),
      onStatus: (status) => {
        if (status.phase === "ended") {
          activeCall = null;
          activeSession = null;
        }
        queryClient.setQueryData<VoiceUiStatus>(statusKey, status);
      },
      ringPcmBase64: (ringTonePcm ??= ringTonePcm16Base64()),
      onLevel: (level) => {
        /* JS-driven on purpose: the sheet's level bar animates WIDTH (a
         * layout prop the native driver rejects), and one Animated.Value
         * cannot serve both drivers. ~11 updates/s of a 6px bar is nothing
         * for the JS driver. */
        Animated.timing(pulse, { toValue: level, duration: 90, useNativeDriver: false }).start();
      },
      now: () => Date.now(),
    });
  } catch (error) {
    activeCall = null;
    activeSession = null;
    await session.stop();
    const failed: VoiceUiStatus = {
      phase: "ended",
      caption: `call failed — ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        140,
      ),
    };
    queryClient.setQueryData<VoiceUiStatus>(statusKey, failed);
  }
}

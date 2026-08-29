// The live call's UI state, shared beyond the call button: the root layout
// shows a WhatsApp-style banner when a call is live and you're anywhere but
// its chat, the note overlay floats the hold-to-talk controls only over
// that chat, and the chat list's phone button starts fresh phone chats.
// Lives apart from the component (react-refresh wants component files
// exporting only components), and in the query cache like every other bit
// of app state (no useState).
import { useQuery } from "@tanstack/react-query";
import type { VoiceCallStatus } from "./voice-call.ts";

export const voiceCallStatusKey = ["voice-call", "status"];
export const voiceCallTargetKey = ["voice-call", "target"];

/** null = no call has ever run this app session. */
export type VoiceUiStatus = (VoiceCallStatus & { micDenied?: boolean }) | null;

/** Which line the active (or last) call is on — always a chat's line now:
 * the chat is the backend (`colleaguePath`) and the call UI navigates to
 * it. Kept after the call ends so error captions still know their home. */
export interface VoiceCallTarget {
  baseUrl: string;
  projectId: string;
  streamPath: string;
  colleaguePath: string;
}

export function useVoiceCallStatus(): VoiceUiStatus {
  const { data } = useQuery<VoiceUiStatus>({
    queryKey: voiceCallStatusKey,
    queryFn: () => null,
    staleTime: Infinity,
    initialData: null,
  });
  return data;
}

export function useVoiceCallTarget(): VoiceCallTarget | null {
  const { data } = useQuery<VoiceCallTarget | null>({
    queryKey: voiceCallTargetKey,
    queryFn: () => null,
    staleTime: Infinity,
    initialData: null,
  });
  return data;
}

/** Whether a call is live right now. */
export function useVoiceCallActive(): boolean {
  const status = useVoiceCallStatus();
  return status !== null && status.phase !== "ended";
}

/** Whether the floating call controls should exist at all: a live call, or
 * an ended one whose caption still needs acting on (a failure to read, the
 * mic-denied tap-through to Settings). A plain "call ended" needs nothing. */
export function useVoiceCallOverlayVisible(): boolean {
  const status = useVoiceCallStatus();
  if (status === null) return false;
  if (status.phase !== "ended") return true;
  return status.micDenied === true || status.caption.startsWith("call failed");
}

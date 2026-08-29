// The live call's UI state, shared beyond the call button: the note
// overlay hides itself on chat screens (chat has its own composer), but a
// LIVE call's controls must float everywhere — so the "is a call on?"
// question lives here, importable without dragging the component along
// (react-refresh wants component files exporting only components).
import { useQuery } from "@tanstack/react-query";
import type { VoiceCallStatus } from "./voice-call.ts";

export const voiceCallStatusKey = ["voice-call", "status"];

/** null = no call has ever run this app session. */
export type VoiceUiStatus = (VoiceCallStatus & { micDenied?: boolean }) | null;

/** Whether a call is live right now — how screens that normally hide the
 * overlay know to keep the call UI floating. */
export function useVoiceCallActive(): boolean {
  const { data: status } = useQuery<VoiceUiStatus>({
    queryKey: voiceCallStatusKey,
    queryFn: () => null,
    staleTime: Infinity,
    initialData: null,
  });
  return status !== null && status.phase !== "ended";
}

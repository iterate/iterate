// One call from a browser: `@iterate-com/voice/call`'s client, the device's calls, with the
// browser's microphone and speaker on either end (audio.ts). A service that is there but failing
// says so before anything is appended.

// registers `itx.voice` on InstalledAppRoots
import type {} from "@iterate-com/voice";
import { startVoiceCall, type VoiceCallStats } from "@iterate-com/voice/call";
import type { IterateContextApiWith } from "iterate/api";
import type { AuthenticatedApp } from "iterate/app";
import { base64ToInt16, int16ToBase64, type AudioSession } from "./audio.ts";

/** `id` counts up per call: the list key (one subscription batch can report several facts at once). */
export type CallFact = { id: number; text: string };

/** What this browser saw of the call, counted by the call client because the relay cannot see the
 *  last hop. */
export type CallStats = VoiceCallStats;

export type Call = {
  /** The conversation's context — what `useLiveState` subscribes to. */
  itx: ReturnType<Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>["cd"]>;
  stats: CallStats;
  hangUp(): Promise<void>;
};

export async function startCall(input: {
  api: AuthenticatedApp["api"];
  projectId: string;
  audio: AudioSession;
  onFact(fact: CallFact): void;
}): Promise<Call> {
  const { api, projectId, audio, onFact } = input;
  const project = await api.projects.get(projectId);
  // The page offers Call only once `itx.voice` is configured (it sets voice up otherwise), so the
  // project answers `voice`.
  const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
  await installed.voice.health().catch((error: unknown) => {
    throw new Error(
      `This project's voice agent isn't answering (${error instanceof Error ? error.message : String(error)}).`,
    );
  });
  let factId = 0;
  const say = (text: string) => onFact({ id: factId++, text });
  const call = await startVoiceCall(installed, {
    client: "web",
    onSpeakerFrame: (frame) => {
      if (frame.clearSpeakerBufferBeforeFrame) audio.speaker.clear();
      if (frame.pcm) audio.speaker.push(base64ToInt16(frame.pcm));
    },
    // The list shows the call's milestones and the provider's troubles; the transcript and the
    // delegations are the live view's (the page's `voice-agent` state).
    onFact: (fact) => {
      switch (fact.type) {
        case "events.iterate.com/voice-agent/conversation-accepted":
          say(`accepted (handshake ${String(fact.payload.handshakeTookMs)} ms)`);
          break;
        case "events.iterate.com/voice-agent/call-ended":
          audio.onFrame = null;
          say(`ended: ${fact.payload.reason}`);
          break;
        case "events.iterate.com/voice-agent/provider-error-reported":
        case "events.iterate.com/voice-agent/provider-disconnected":
          say(
            `${fact.type.replace("events.iterate.com/voice-agent/", "")}: ${JSON.stringify(fact.payload).slice(0, 160)}`,
          );
          break;
      }
    },
  });
  say(`call started on ${call.streamPath}`);
  audio.onFrame = (pcm) => {
    call.sendMicFrame(int16ToBase64(pcm));
  };
  return {
    itx: call.itx,
    stats: call.stats,
    async hangUp() {
      audio.onFrame = null;
      await call.hangUp("hung up");
    },
  };
}

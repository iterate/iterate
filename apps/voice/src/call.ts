// One call from a browser: the device's exact calls (apps/agents/scripts/voice-call.ts, in a
// browser). Press = a fresh context: one `setupVoiceAgent` append puts the relay and the agent on
// it and starts the call; a subscription brings the answer's frames and the call's facts back;
// microphone frames go up as ephemeral appends, twenty a second; hanging up appends the terminal.

// registers `itx.voice` on InstalledAppRoots
import type {} from "../../agents/voice/api.ts";
import type { IterateContextApiWith } from "iterate/api";
import type { AuthenticatedApp } from "iterate/app";
import { base64ToInt16, int16ToBase64, type AudioSession } from "./audio.ts";

/** `id` counts up per call: the list key (one subscription batch can report several facts at once). */
export type CallFact = { id: number; text: string };

/** What this browser saw of the call, counted here because the relay cannot see the last hop. */
export type CallStats = {
  micFramesSent: number;
  /** Frames the microphone produced while five appends were still in flight (a slow link). */
  micFramesDropped: number;
  spkChunksReceived: number;
  spkMsReceived: number;
  handshakeMs: number | null;
};

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
  const activation = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const streamPath = `/agents/voice/web/${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${activation}`;
  const project = await api.projects.get(projectId);
  // The page offers Call only once `itx.voice` is configured (it installs voice otherwise), so the
  // project answers `voice`; a service that is there but failing says so before anything is appended.
  const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
  await installed.voice.health().catch((error: unknown) => {
    throw new Error(
      `This project's voice agent isn't answering (${error instanceof Error ? error.message : String(error)}).`,
    );
  });
  const call = project.cd(streamPath);
  let factId = 0;
  const stats: CallStats = {
    micFramesSent: 0,
    micFramesDropped: 0,
    spkChunksReceived: 0,
    spkMsReceived: 0,
    handshakeMs: null,
  };
  const setup = installed.voice.setupVoiceAgent({ streamPath, activation });
  const subscription = await call.subscribe({
    name: `web-${activation}`,
    consumes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/conversation-accepted",
      "events.iterate.com/voice-agent/conversation-ended",
      "events.iterate.com/voice-agent/provider-error-reported",
      "events.iterate.com/voice-agent/provider-disconnected",
    ],
    target: (events) => {
      for (const raw of events) {
        // capnweb hands each row over as a plain JSON value; the shape is the relay's event contract
        const event = raw as { type: string; payload: Record<string, unknown> };
        const p = event.payload;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          if (p.activation !== activation) continue;
          if (p.clearSpeakerBufferBeforeFrame) audio.speaker.clear();
          if (typeof p.pcm === "string" && p.pcm !== "") {
            const pcm = base64ToInt16(p.pcm);
            stats.spkChunksReceived += 1;
            stats.spkMsReceived += pcm.length / 16;
            audio.speaker.push(pcm);
          }
        } else if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
          stats.handshakeMs = Number(p.handshakeTookMs);
          onFact({ id: factId++, text: `accepted (handshake ${String(p.handshakeTookMs)} ms)` });
        } else if (event.type === "events.iterate.com/voice-agent/conversation-ended") {
          audio.onFrame = null;
          onFact({ id: factId++, text: `ended: ${String(p.reason)}` });
        } else {
          const kind = event.type.replace("events.iterate.com/voice-agent/", "");
          onFact({ id: factId++, text: `${kind}: ${JSON.stringify(p).slice(0, 160)}` });
        }
      }
    },
  });
  await setup;
  onFact({ id: factId++, text: `call started on ${streamPath}` });
  let sending = 0;
  audio.onFrame = (pcm) => {
    // Fire and forget, twenty a second; a slow link drops frames rather than queueing them.
    if (sending > 4) {
      stats.micFramesDropped += 1;
      return;
    }
    sending += 1;
    stats.micFramesSent += 1;
    void call
      .append({
        type: "events.iterate.com/voice-agent/mic-frame",
        ephemeral: true,
        payload: { activation, pcm: int16ToBase64(pcm) },
      })
      .catch(() => undefined)
      .finally(() => {
        sending -= 1;
      });
  };
  const keepalive = setInterval(() => {
    void call
      .append({ type: "events.iterate.com/voice-agent/keepalive", ephemeral: true, payload: {} })
      .catch(() => undefined);
  }, 20_000);
  return {
    itx: call,
    stats,
    async hangUp() {
      clearInterval(keepalive);
      audio.onFrame = null;
      await call
        .append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: { activation, reason: "hung up" },
        })
        .catch(() => undefined);
      try {
        subscription[Symbol.dispose]();
      } catch {
        // the session may already be gone
      }
    },
  };
}

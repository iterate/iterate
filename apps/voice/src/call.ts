// One call from a browser: the device's exact calls (apps/os-next/scripts/voice-call.ts, in a
// browser). Press = a fresh context: one `setupVoiceAgent` append puts the relay and the agent on
// it and starts the call; a subscription brings the answer's frames and the call's facts back;
// microphone frames go up as ephemeral appends, twenty a second; hanging up appends the terminal.
import type { AuthenticatedApp } from "iterate/next/app";
import { base64ToInt16, int16ToBase64, type AudioSession } from "./audio.ts";

const T = "events.iterate.com/voice-agent/";

/** The slice of a context stub the call uses (capnweb pipelines every one of these). */
export type CallItx = {
  invoke(expression: unknown): Promise<unknown>;
  append(...events: object[]): Promise<unknown>;
  subscribe(input: {
    name: string;
    consumes: string[];
    target: (events: unknown[], range: unknown) => void;
  }): Promise<{ [Symbol.dispose](): void }>;
};

export type CallFact = { at: number; text: string };

export type Call = {
  streamPath: string;
  activation: string;
  /** The conversation's context — what `useLiveState` subscribes to. */
  itx: CallItx;
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
  // A project with no voice install has no `itx.voice`: say so before anything is appended.
  await project.invoke(["itx", "voice", ["health"]]).catch((error: unknown) => {
    throw new Error(
      `This project has no voice agent yet (${error instanceof Error ? error.message : String(error)}). Run apps/os-next/scripts/voice-install.ts for it.`,
    );
  });
  const call = (project as unknown as { cd(path: string): CallItx }).cd(streamPath);
  const setup = project.invoke(["itx", "voice", ["setupVoiceAgent", { streamPath, activation }]]);
  const subscription = await call.subscribe({
    name: `web-${activation}`,
    consumes: [
      `${T}spk-frame`,
      `${T}conversation-accepted`,
      `${T}conversation-ended`,
      `${T}provider-error`,
      `${T}provider-disconnected`,
    ],
    target: (events) => {
      for (const raw of events) {
        const event = JSON.parse(JSON.stringify(raw)) as {
          type: string;
          payload: Record<string, unknown>;
        };
        const kind = event.type.slice(T.length);
        const p = event.payload;
        if (kind === "spk-frame") {
          if (p.activation !== activation) continue;
          if (p.clearSpeakerBufferBeforeFrame) audio.speaker.clear();
          if (typeof p.pcm === "string" && p.pcm !== "") audio.speaker.push(base64ToInt16(p.pcm));
        } else if (kind === "conversation-accepted") {
          onFact({ at: Date.now(), text: `accepted (handshake ${String(p.handshakeTookMs)} ms)` });
        } else if (kind === "conversation-ended") {
          audio.onFrame = null;
          onFact({ at: Date.now(), text: `ended: ${String(p.reason)}` });
        } else {
          onFact({ at: Date.now(), text: `${kind}: ${JSON.stringify(p).slice(0, 160)}` });
        }
      }
    },
  });
  await setup;
  onFact({ at: Date.now(), text: `call started on ${streamPath}` });
  let sending = 0;
  audio.onFrame = (pcm) => {
    // Fire and forget, twenty a second; a slow link drops frames rather than queueing them.
    if (sending > 4) return;
    sending += 1;
    void call
      .append({
        type: `${T}mic-frame`,
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
      .append({ type: `${T}keepalive`, ephemeral: true, payload: {} })
      .catch(() => undefined);
  }, 20_000);
  return {
    streamPath,
    activation,
    itx: call,
    async hangUp() {
      clearInterval(keepalive);
      audio.onFrame = null;
      await call
        .append({ type: `${T}conversation-ended`, payload: { activation, reason: "hung up" } })
        .catch(() => undefined);
      try {
        subscription[Symbol.dispose]();
      } catch {
        // the session may already be gone
      }
    },
  };
}

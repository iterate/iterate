// The voice ↔ itx multiplexer. One Node process holds two connections:
//
//   - a realtime voice session (Grok Voice Agent API / OpenAI Realtime) that
//     does the *talking*, and
//   - an itx agent (`/agents/voice-assistant` by default) that does the *work*.
//
// Realtime voice models are unreliable tool callers, so by default the bridge
// does not wait for one: every completed user turn is forwarded to the itx
// agent client-side (`agent.sendMessage`), and the agent's reply is injected
// back into the voice conversation as a `[worker report] …` user item plus
// `response.create`, so the voice agent relays results out loud. An
// `ask_assistant` function tool is still registered — when the voice model
// does call it, the call is acked immediately and treated as a forward.

import process from "node:process";
import readline from "node:readline";
import type { RpcStub } from "capnweb";
import { connectItx } from "../../src/itx-client.ts";
import type { Agent } from "../../src/types.ts";
import { createSpeaker, startMicCapture } from "./audio.ts";
import {
  connectRealtime,
  providerDefaults,
  resolveProvider,
  type RealtimeServerEvent,
} from "./realtime.ts";

const WORKER_REPLY_EVENT = "events.iterate.com/agents/web-message-sent";
const WORKER_IDLE_REPLY = "(idle)";
const WORKER_REPLY_TIMEOUT_MS = 120_000;

const VOICE_AGENT_INSTRUCTIONS = `
You are Iterate's voice assistant — the spoken front-end of a two-agent team.
Alongside you runs a "worker" agent connected to the user's Iterate project.
The worker hears everything the user says and does all actual work: running
scripts, listing files and repos, managing the project. You cannot do any of
that yourself, and you must never invent results.

When the user asks for something actionable, acknowledge briefly and naturally
("on it", "let me get that going") — the worker is already working on it.

Messages starting with "[worker report]" are not from the human: they are
results arriving from the worker. Relay their substance to the user
conversationally and concisely.

Keep every response short. This is a spoken conversation.
`.trim();

const ASK_ASSISTANT_TOOL = {
  type: "function" as const,
  name: "ask_assistant",
  description:
    "Send a natural-language request to the worker agent connected to the user's Iterate project. The worker replies asynchronously as a later [worker report] message; this call returns immediately with an acknowledgement.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "The request, phrased for the worker agent." },
    },
    required: ["request"],
  },
};

type BridgeOptions = {
  provider?: string;
  model?: string;
  voice?: string;
  project?: string;
  createProject?: boolean;
  agentPath: string;
  text?: boolean;
  forward: "auto" | "tool";
  baseUrl: string;
  adminSecret: string;
  mic: string;
};

export async function runVoiceBridge(options: BridgeOptions) {
  const provider = resolveProvider(options.provider);
  const defaults = providerDefaults[provider];
  const apiKey = process.env[defaults.apiKeyEnvVar]?.trim();
  if (!apiKey) throw new Error(`${defaults.apiKeyEnvVar} is required for provider ${provider}.`);

  const auth = { type: "admin-secret" as const, secret: options.adminSecret };
  const projectId = options.createProject
    ? await createThrowawayProject({ auth, baseUrl: options.baseUrl })
    : options.project;
  if (!projectId) throw new Error("Pass --project <id> or --create-project.");

  using agent = connectItx({
    agentPath: options.agentPath,
    auth,
    baseUrl: options.baseUrl,
    projectId,
  });

  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`voice: ${provider} (${options.model || defaults.model})`);
  say(`worker: ${projectId}${options.agentPath} @ ${options.baseUrl}`);
  say(options.text ? `mode: text — type, enter to send, ctrl-c to quit` : `mode: audio — speak!`);

  const speaker = createSpeaker();
  // The realtime API rejects a `response.create` while another response is
  // active, so worker reports queue until the current response finishes.
  let responseActive = false;
  const injectionQueue: (() => void)[] = [];
  const whenResponseIdle = (inject: () => void) => {
    if (responseActive) injectionQueue.push(inject);
    else inject();
  };

  // User-turn transcripts, keyed by conversation item id. Grok streams
  // incremental `.updated` transcription events; OpenAI sends `.completed`.
  // Turn end is signalled by `.completed` or by the VAD kicking off a
  // response — whichever comes first wins, the other is deduped.
  const turnTranscripts = new Map<string, string>();
  const forwardedItems = new Set<string>();

  const forwardTurn = (text: string, origin: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    say(`  → worker (${origin}): ${trimmed}`);
    void askWorker(agent, trimmed)
      .then((reply) => {
        if (reply === WORKER_IDLE_REPLY) {
          say(`  ← worker: (idle — nothing to report)`);
          return;
        }
        say(`  ← worker: ${reply}`);
        whenResponseIdle(() => {
          session.send(userTextItem(`[worker report] ${reply}`));
          session.send({ type: "response.create" });
        });
      })
      .catch((error: Error) => {
        say(`  ← worker error: ${error.message}`);
        whenResponseIdle(() => {
          session.send(userTextItem(`[worker report] The worker hit an error: ${error.message}`));
          session.send({ type: "response.create" });
        });
      });
  };

  const forwardTurnFromItem = (itemId: string, origin: string) => {
    if (forwardedItems.has(itemId)) return;
    const transcript = turnTranscripts.get(itemId);
    if (!transcript?.trim()) return;
    forwardedItems.add(itemId);
    say(`you (heard): ${transcript.trim()}`);
    if (options.forward === "auto") forwardTurn(transcript, origin);
  };

  let assistantLineOpen = false;
  const printDelta = (delta: string) => {
    if (!assistantLineOpen) {
      process.stdout.write("assistant: ");
      assistantLineOpen = true;
    }
    process.stdout.write(delta);
  };
  const endAssistantLine = () => {
    if (assistantLineOpen) process.stdout.write("\n");
    assistantLineOpen = false;
  };

  const onEvent = (event: RealtimeServerEvent) => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        return;
      case "response.created":
        responseActive = true;
        // The VAD starting a response means the user's turn ended — forward
        // whatever transcript we have even if `.completed` never arrives.
        for (const itemId of turnTranscripts.keys()) forwardTurnFromItem(itemId, "vad");
        return;
      case "response.done": {
        endAssistantLine();
        responseActive = false;
        const inject = injectionQueue.shift();
        inject?.();
        return;
      }
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = String(event.item_id);
        const previous = event.type.endsWith("delta") ? turnTranscripts.get(itemId) || "" : "";
        turnTranscripts.set(itemId, previous + String(event.transcript || event.delta || ""));
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = String(event.item_id);
        turnTranscripts.set(itemId, String(event.transcript || ""));
        forwardTurnFromItem(itemId, "transcription");
        return;
      }
      case "response.function_call_arguments.done": {
        const args = JSON.parse(String(event.arguments || "{}")) as { request?: string };
        say(`  (voice model called ${event.name})`);
        session.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({ status: "forwarded to worker; report will follow" }),
          },
        });
        whenResponseIdle(() => session.send({ type: "response.create" }));
        // In auto mode the turn was already forwarded verbatim — the tool call
        // is just the voice model agreeing with us. Only forward in tool mode.
        if (options.forward === "tool" && args.request) forwardTurn(args.request, "tool-call");
        return;
      }
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (!options.text) speaker.play(String(event.delta));
        return;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta":
        printDelta(String(event.delta));
        return;
      case "input_audio_buffer.speech_started":
        speaker.stop(); // barge-in
        return;
      case "error":
        say(`realtime error: ${JSON.stringify(event.error || event)}`);
        return;
      default:
        return;
    }
  };

  // The bridge must stay pending until the conversation ends: the CLI exits
  // when this function resolves, and `using agent` is disposed at return.
  let endConversation = () => {};
  const conversationEnded = new Promise<void>((resolve) => {
    endConversation = resolve;
  });
  let closingIntentionally = false;

  const session = connectRealtime({
    provider,
    model: options.model || defaults.model,
    apiKey,
    instructions: VOICE_AGENT_INSTRUCTIONS,
    voice: options.voice || defaults.voice,
    tools: [ASK_ASSISTANT_TOOL],
    audioInput: !options.text,
    onEvent,
    onClose: ({ code, reason }) => {
      if (!closingIntentionally) {
        say(`realtime socket closed unexpectedly (${code}${reason ? `: ${reason}` : ""})`);
        process.exitCode = 1;
      }
      endConversation();
    },
  });
  await session.ready;

  if (options.text) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      whenResponseIdle(() => {
        session.send(userTextItem(line));
        session.send({ type: "response.create" });
      });
      if (options.forward === "auto") forwardTurn(line, "text");
    });
    rl.on("close", () => {
      closingIntentionally = true;
      speaker.dispose();
      session.close();
    });
    await conversationEnded;
    return;
  }

  const mic = startMicCapture({
    device: options.mic,
    onChunk: (base64) => session.send({ type: "input_audio_buffer.append", audio: base64 }),
    onExit: ({ code }) => {
      if (closingIntentionally) return;
      say(`mic capture exited (${code}) — check the ffmpeg avfoundation device (--mic).`);
      process.exitCode = 1;
      endConversation();
    },
  });
  process.on("SIGINT", () => {
    closingIntentionally = true;
    mic.stop();
    speaker.dispose();
    session.close();
  });
  await conversationEnded;
}

/**
 * Send one message to the worker agent and wait for its reply. Same shape as
 * `Agent.ask`, but with a client-side wait so codemode work gets more than the
 * server-side 45s.
 */
async function askWorker(agent: RpcStub<Agent>, text: string) {
  const message = [
    text,
    '(You are the worker agent behind a live voice assistant; the message above is one transcribed voice turn. Reply concisely — your reply is read aloud. If it needs no action or answer, reply exactly "(idle)".)',
  ].join("\n\n");
  const sent = await agent.sendMessage(message);
  const reply = await agent.stream.waitForEvent({
    afterOffset: sent.offset,
    eventTypes: [WORKER_REPLY_EVENT],
    timeoutMs: WORKER_REPLY_TIMEOUT_MS,
  });
  const payload = reply.payload as { message?: unknown };
  return typeof payload.message === "string" ? payload.message.trim() : JSON.stringify(payload);
}

async function createThrowawayProject(connection: {
  auth: { type: "admin-secret"; secret: string };
  baseUrl: string;
}) {
  const slug = `voice-${Date.now().toString(36)}`;
  using session = connectItx(connection);
  using project = session.projects.create({ slug });
  const description = await project.describe();
  return description.projectId;
}

function userTextItem(text: string) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

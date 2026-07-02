// CLI I/O pump for the voice ↔ itx bridge. One Node process holds two
// connections:
//
//   - a realtime voice session (Grok Voice Agent API / OpenAI Realtime) that
//     does the *talking*, and
//   - an itx agent stream (`/agents/voice/**`) whose `voice` stream processor
//     (apps/os/src/domains/voice/) does the multiplexing: it renders appended
//     `voice/user-turn-transcribed` facts into agent input and projects agent
//     replies into `voice/say-requested` events, which this process relays
//     into the realtime conversation as `[worker report] …` items.
//
// Realtime voice models are unreliable tool callers, so nothing depends on
// them calling tools: every completed user turn is appended to the stream.
// The `ask_assistant` tool is still registered (acked when called), and
// `no_comment` gives the voice model a structurally silent out for redundant
// reports.

import process from "node:process";
import readline from "node:readline";
import { connectItx } from "../../src/itx-client.ts";
import { createSpeaker, startMicCapture } from "./audio.ts";
import {
  connectRealtime,
  providerDefaults,
  resolveProvider,
  type RealtimeServerEvent,
} from "./realtime.ts";

const USER_TURN_EVENT = "events.iterate.com/voice/user-turn-transcribed";
const ASSISTANT_UTTERANCE_EVENT = "events.iterate.com/voice/assistant-utterance-completed";
const SAY_REQUESTED_EVENT = "events.iterate.com/voice/say-requested";
const REPORT_SUPPRESSED_EVENT = "events.iterate.com/voice/report-suppressed";
const WORKER_REPLY_EVENT = "events.iterate.com/agents/web-message-sent";
const WORKER_IDLE_REPLY = "(idle)";

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
conversationally and concisely. If a report only repeats what the user has
already been told, call the no_comment function instead of speaking — never
re-announce or re-confirm information the user already heard.

Keep every response short. This is a spoken conversation. Always speak
English unless the user clearly asks for another language — never switch
languages based on a short or ambiguous utterance.
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

// A function-call response produces no audio, so this is the structurally
// guaranteed way for the voice model to stay silent when a worker report is
// redundant. Worst case it ignores the tool and talks — today's behavior.
const NO_COMMENT_TOOL = {
  type: "function" as const,
  name: "no_comment",
  description:
    "Stay silent instead of responding. Call this when the latest [worker report] adds nothing the user hasn't already been told.",
  parameters: { type: "object", properties: {} },
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

  // Assistant deltas stream onto an open line; any other output must close
  // that line first or the two interleave mid-word.
  let assistantLineOpen = false;
  let assistantUtterance = "";
  const endAssistantLine = () => {
    if (assistantLineOpen) process.stdout.write("\n");
    assistantLineOpen = false;
  };
  const say = (line: string) => {
    endAssistantLine();
    process.stdout.write(`${line}\n`);
  };
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
  // Mark the response active BEFORE the server confirms it — waiting for
  // `response.created` leaves a window where a second injection races in and
  // the API rejects it with `conversation_already_has_active_response`.
  const sendResponseCreate = () => {
    responseActive = true;
    session.send({ type: "response.create" });
  };

  // User-turn transcripts, keyed by conversation item id. Grok streams
  // incremental `.updated` transcription events; OpenAI sends `.completed`.
  // Turn end is signalled by `.completed` or by the VAD kicking off a
  // response — whichever comes first wins, the other is deduped.
  const turnTranscripts = new Map<string, string>();
  const forwardedItems = new Set<string>();
  // The worker lane is stream-native: forwarding a turn is appending a
  // `voice/user-turn-transcribed` fact. The `voice` stream processor
  // (apps/os/src/domains/voice/) renders it into agent input; this client
  // never talks to the agent directly.
  const forwardTurn = (text: string, origin: "speech" | "text" | "tool-call") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    say(`  \u2192 worker (${origin}): ${trimmed}`);
    void agent.stream
      .append({ type: USER_TURN_EVENT, payload: { transcript: trimmed, origin } })
      .catch((error: Error) => say(`  \u26a0 failed to reach the worker stream: ${error.message}`));
  };

  // The other half of the lane: the voice processor projects agent replies
  // into `voice/say-requested` events; this loop relays them into the
  // realtime conversation. Raw `web-message-sent` events (including the
  // "(idle)" sentinel the processor swallows) are printed for visibility but
  // never injected — injection follows say-requests only.
  const listenToWorker = async () => {
    let cursor = 0;
    while (!closingIntentionally) {
      let workerEvent;
      try {
        workerEvent = await agent.stream.waitForEvent({
          afterOffset: cursor,
          eventTypes: [SAY_REQUESTED_EVENT, WORKER_REPLY_EVENT],
          timeoutMs: 60_000,
        });
      } catch {
        // timeout (no worker activity) or transient disconnect — keep going
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      cursor = workerEvent.offset;
      const message = String((workerEvent.payload as { message?: unknown }).message || "").trim();
      if (workerEvent.type === WORKER_REPLY_EVENT) {
        say(
          message === WORKER_IDLE_REPLY
            ? `  \u2190 worker: (idle \u2014 nothing to report)`
            : `  \u2190 worker: ${message}`,
        );
        continue;
      }
      whenResponseIdle(() => {
        session.send(userTextItem(`[worker report] ${message}`));
        sendResponseCreate();
      });
    }
  };

  const forwardTurnFromItem = (itemId: string) => {
    if (forwardedItems.has(itemId)) return;
    const transcript = turnTranscripts.get(itemId);
    if (!transcript?.trim()) return;
    forwardedItems.add(itemId);
    say(`you (heard): ${transcript.trim()}`);
    if (options.forward === "auto") forwardTurn(transcript, "speech");
  };

  const printDelta = (delta: string) => {
    if (!assistantLineOpen) {
      process.stdout.write("assistant: ");
      assistantLineOpen = true;
    }
    assistantUtterance += delta;
    process.stdout.write(delta);
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
        for (const itemId of turnTranscripts.keys()) forwardTurnFromItem(itemId);
        return;
      case "response.done": {
        endAssistantLine();
        if (assistantUtterance.trim()) {
          // Audit fact only — makes the voice side visible in the journal.
          void agent.stream
            .append({ type: ASSISTANT_UTTERANCE_EVENT, payload: { text: assistantUtterance } })
            .catch(() => {});
        }
        assistantUtterance = "";
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
        forwardTurnFromItem(itemId);
        return;
      }
      case "response.function_call_arguments.done": {
        if (String(event.name) === "no_comment") {
          // Complete the call but do NOT trigger a response — the silence is
          // the point. The report stays in context for later turns.
          session.send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: event.call_id, output: "{}" },
          });
          say(`  (worker report noted silently)`);
          void agent.stream.append({ type: REPORT_SUPPRESSED_EVENT, payload: {} }).catch(() => {});
          return;
        }
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
        whenResponseIdle(() => sendResponseCreate());
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
    tools: [ASK_ASSISTANT_TOOL, NO_COMMENT_TOOL],
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
  void listenToWorker();

  if (options.text) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      whenResponseIdle(() => {
        session.send(userTextItem(line));
        sendResponseCreate();
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

import {
  IterateDurableObject,
  IterateWorkerEntrypoint,
  type Agent,
  type StatefulDynamicWorkerRef,
  type Stream,
  createProcessorHost,
} from "iterate/sdk";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";

// Voice-agent guest worker: the "server side" of the voice pipe, in userspace.
//
// Three modes, one Durable Object, reached via wss to the `voice` app host
// (voice--<slug>.<base>/?mode=...):
//
//   mode=proxy    client WS <-> Grok WS, frames pumped verbatim. The client
//                 speaks the Grok realtime protocol itself. This is the
//                 "simple websocket proxy" baseline.
//
//   mode=bridge   audio rides the STREAM: mic-frame ephemeral events in,
//                 spk-frame/grok-event ephemeral events out, exactly the
//                 voicelab node-bridge protocol. The client's WebSocket to
//                 this DO carries no audio — it is the lifetime anchor that
//                 keeps this invocation's context (and with it the outbound
//                 Grok socket + the live openConnection callback) alive.
//
//   mode=detached same bridge, no anchor socket: the call holds ITSELF open
//                 with ctx.waitUntil for as long as it is doing work, and
//                 ends on the stream's call-ended event, on Grok hanging up,
//                 on silence, or at the hard deadline. This is what a device
//                 uses — a `voicelab/call-requested` stream event returns the moment the
//                 Grok session is live and nothing outside the platform has
//                 to stay running for the call to continue.
//
// The Grok key never enters this isolate: the upgrade fetch carries a
// getSecret placeholder that the platform substitutes en route to the
// pinned origin.

const XAI_SECRET = "/secrets/xai";
/** The real provider. Overridable per call with `grokBaseUrl` — see dialGrok. */
const GROK_REALTIME_URL = "https://api.x.ai/v1/realtime";
/**
 * A call with no mic frames and no Grok traffic for this long is over.
 * Pings deliberately do NOT count: a device pinging into an empty room is
 * exactly the case this is here to end.
 */
const IDLE_TIMEOUT_MS = 600_000;
/**
 * Backstop so a wedged detached call can never hold a DO forever. The goal
 * is hour-long conversations, so this is not the thing that should end one:
 * a device losing its bridge now notices within 20s and opens another, but
 * an hour of talking should not need that to happen at all.
 */
const MAX_CALL_MS = 3_900_000;
/**
 * How long a call gets to come up at all before it is a failed call.
 *
 * `startCall` resolves when the provider accepts the session, so anything
 * that stops the handshake completing blocks the CALLER — and a device whose
 * call button does nothing has no way to tell "still connecting" from
 * "never going to". Deliberately generous against the ~750ms a healthy dial
 * takes, and deliberately far below the ten-minute idle timeout that used to
 * be the only thing that ended such a call.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * The agent that does the actual thinking. Grok is a mouth and a pair of
 * ears with a ~200ms budget; anything that needs reading a repo, calling a
 * tool, or being RIGHT belongs to a text model with no clock on it.
 */
const COLLEAGUE_PATH = "/agents/colleague";
const VOICE_AGENT_PROCESSOR_SLUG = "voice-agent";
const VOICE_AGENT_SUBSCRIPTION_KEY = "app-voice-agent#voice-agent";
const CALL_REQUEST_FRESHNESS_MS = 30_000;
/**
 * What the voice model is told it is.
 *
 * Two paragraphs are load-bearing. Without an explicit instruction to keep
 * talking, a voice model handed an asynchronous tool goes silent waiting for
 * it, which sounds exactly like a dropped call. And without being told that
 * the back office is a colleague rather than a function — free to reply out
 * of order, several times, or not at all — it treats the first message that
 * arrives as the answer to whatever it asked last, and says so out loud.
 */
const VOICE_INSTRUCTIONS = [
  "You are the FRONT OFFICE of a two-part team. You talk to the customer out loud;",
  "you are not the one who does the work. Behind you is the BACK OFFICE — a",
  "careful, well-read expert with access to the customer's systems — who does",
  "anything that needs real thought, real knowledge, or action in the world. Your",
  "job is to listen well, be good company, and be the voice of the two of you.",
  "",
  "Use message_back_office for anything worth getting right, and for anything you",
  "would otherwise guess at. It is a MESSAGE, not a question: send it to ask, to",
  "answer something they asked you, to pass on what the customer just said, or to",
  "tell them a plan changed. It returns immediately — they are reading, not",
  "replying — so do NOT go quiet waiting. Say you have sent it, and keep the",
  "conversation going: ask what prompted the question, or talk about something",
  "else.",
  "",
  "MESSAGES ARE NUMBERED, as a courtesy between the two of you. Sending returns",
  "'sent as message #n'. Their replies arrive as 'The back office says', and when",
  "one is about something you sent it will start with that number. Expect the",
  "back office to be a colleague, not a machine: it may reply to your second",
  "message before your first, send two or three about one thing, ask you a",
  "question back, or volunteer something nobody asked for. Any of that is normal.",
  "",
  "So when a message arrives, read what it actually says before deciding what it",
  "is. If it carries a number, tell the customer which thread it belongs to — 'on",
  "the invoice you asked about…'. If it does not, do not invent one: pass it on",
  "as something the back office sent along. If it asks you something, answer it",
  "with message_back_office — you can see the customer and they cannot.",
  "",
  "Speak plainly and briefly — one or two sentences unless asked for more. Never",
  "read out URLs, code, or long lists.",
].join(" ");
const BACK_OFFICE_BRIEF = [
  "You are the BACK OFFICE of a two-part assistant. A voice model is",
  "the FRONT OFFICE: it talks to a customer out loud, and it is the only",
  "way anything you say reaches them. Everything the customer says and",
  "everything the front office says arrives here as context, so you always",
  "know the conversation without being asked about it.",
  "",
  "This is messaging, not question-and-answer. You and the front office are",
  "colleagues passing notes. Send a message whenever you have something",
  "worth saying: an answer, a partial answer while you keep working, a",
  "question back, a correction, or something nobody asked for that they",
  "plainly need to know. Send as many as you like, in any order, at any",
  "time. Nothing is waiting on you, so silence is always an option and a",
  "slow careful reply is better than a fast wrong one.",
  "",
  "Messages arrive labelled 'Message #n'. When yours is about a particular",
  "one, START with that label — '#3: An octopus has three hearts…' — so the",
  "front office can tell the customer which thread it is picking up. When",
  "it is about nothing in particular, just say it.",
  "",
  "SEND A CHAT MESSAGE. That is the only channel that reaches the customer",
  "— work in scripts all you like, but the words themselves have to be a",
  "message. Everything you send will be read out loud, so write to be",
  "spoken: two or three sentences of plain language, no lists, no URLs, no",
  "code. Lead with the point.",
].join("\n");
/** The brief as the context event that carries it — one payload, one key. */
const BACK_OFFICE_BRIEF_CONTEXT = {
  content: BACK_OFFICE_BRIEF,
  key: "voicelab/colleague-brief",
  llmRequestPolicy: { behaviour: "dont-trigger-request" },
  role: "system",
} as const;
const BACK_OFFICE_BRIEF_KEY = `voice-agent/back-office-brief:${contentHash(BACK_OFFICE_BRIEF_CONTEXT)}`;

/**
 * The back office exists, and knows what it is for.
 *
 * Called from setup AND from the call path, because a call can perfectly well
 * start without setup ever having run: a direct `startCall`, a `mode=bridge`
 * host, a project somebody configured by hand. Appending to an agent that is
 * not there fails quietly down in the call path while `handleToolCall` goes on
 * telling the model "the back office will reply when it has something" — so
 * the assistant keeps promising a colleague that never answers.
 */
async function ensureBackOffice(agent: Agent) {
  try {
    // Nothing may be appended to the agent's stream before the agent exists.
    await agent.create({});
  } catch {
    /* Already born: create over an existing agent is loud, not fatal. */
  }
  return await agent.append({
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: BACK_OFFICE_BRIEF_KEY,
    payload: BACK_OFFICE_BRIEF_CONTEXT,
  });
}

/*
 * LOOSE, DELIBERATELY — the same doctrine the callId filter is built on: the
 * peers are not all in this repository.
 *
 * A strict object rejects the whole event for one field nobody here has heard
 * of, and the failure is total and silent: the event is skipped, no call
 * happens, and nothing says why. Firmware stamping a build id, a script
 * carrying its own correlation field, a future field added on the device
 * before it is added here — every one of those is a dropped call. The fields
 * this bridge acts on are still validated; the rest ride along untouched.
 */
const VoiceCallRequestedPayload = z.looseObject({
  callId: z.string().trim().min(1),
  colleague: z.boolean().optional(),
  effort: z.enum(["none", "high"]).optional(),
  greet: z.string().optional(),
  grokBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  instructions: z.string().optional(),
  model: z.string().trim().min(1).optional(),
  turns: z.enum(["manual", "vad"]).optional(),
  voice: z.string().trim().min(1).optional(),
});

export const VoiceAgentProcessorContract = defineProcessorContract({
  slug: VOICE_AGENT_PROCESSOR_SLUG,
  version: "1.0.0",
  description: "Starts bounded voice bridges from fresh call requests on one configured stream.",
  stateSchema: z.object({
    birthCertificate: z.strictObject({}).nullable().default(null),
    /**
     * The call request nothing has answered yet — the OBLIGATION.
     *
     * Starting a bridge is long work that no longer holds the cursor, so what
     * recovers the outcome when an attempt is dropped cannot be the closure
     * that was dropped with it. It is this: a request opens the obligation,
     * the bridge's own `call-accepted` or this processor's `call-failed`
     * closes it, and the at-head pass takes on whatever is still open.
     */
    pendingCall: z
      .object({
        callId: z.string(),
        /** Epoch ms of the request, so the freshness window survives eviction. */
        requestedAtMs: z.number(),
        /** What to start, verbatim, so a revived incarnation can retry it. */
        request: VoiceCallRequestedPayload,
      })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/voice-agent/created": {
      description: "The voice-agent guest exists on this stream.",
      payloadSchema: z.strictObject({}),
    },
    "voicelab/call-requested": {
      description: "A listener asked the configured voice-agent guest to open a call.",
      payloadSchema: VoiceCallRequestedPayload,
    },
    "voicelab/call-accepted": {
      description: "A bridge has this call live: the provider accepted the session.",
      /* The BRIDGE writes this one; loose for the same reason as the request. */
      payloadSchema: z.looseObject({ callId: z.string().trim().min(1) }),
    },
    "voicelab/call-failed": {
      description: "The call a listener asked for will not happen, and why.",
      payloadSchema: z.looseObject({
        callId: z.string().trim().min(1),
        reason: z.string(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "voicelab/call-requested",
    /* The ANSWERS, so an outstanding request is a fact of the fold rather
     * than a closure that an eviction takes with it. */
    "voicelab/call-accepted",
    "voicelab/call-failed",
  ],
  emits: ["voicelab/call-failed"],
});
export type VoiceAgentProcessorContract = typeof VoiceAgentProcessorContract;
const FORWARDED_GROK_EVENTS = new Set([
  /*
   * `error` and the commit acknowledgement are here because their ABSENCE is
   * the symptom that costs the most: a device that talks and gets nothing
   * back looks identical whether its audio never arrived, arrived as
   * nonsense, or arrived fine and the provider rejected the commit. Only the
   * provider can tell those apart, so its complaints ride the stream too.
   */
  "error",
  "input_audio_buffer.committed",
  "response.function_call_arguments.done",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "conversation.item.input_audio_transcription.updated",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.added",
  "response.created",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.done",
]);

export class VoiceBridge extends IterateDurableObject {
  /*
   * One live call per instance. A DO instance is keyed by the stream path, so
   * a second startCall on the same stream lands HERE — and without this, its
   * Grok socket and its stream subscription simply joined the first one's.
   * Every one of them then saw the same voicelab/turn commit and answered it,
   * which is heard as the assistant replying two or three times to one turn.
   */
  #endActiveCall: ((reason: string, superseded?: boolean) => void) | null = null;
  /**
   * The callId the live call belongs to.
   *
   * Kept because "a second startCall on this stream" and "the SAME call asked
   * for again" are different things and used not to be. A client that has not
   * seen its acceptance yet re-requests — the host CLI does so every few
   * seconds, and it must, since a request can be lost. Superseding on that
   * re-request made the bridge kill its own call mid-build, the client then
   * asked again, and the conversation never started: the stream showed
   * `call-failed "superseded by a new call"` followed by an acceptance that
   * was itself superseded, over and over. A cold bridge takes longer to build
   * than the client waits, so this was reachable on any first call.
   */
  #activeCallId: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "proxy";
    const detached = mode === "detached";
    if (!detached && request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("voicelab bridge: expected a websocket upgrade", { status: 426 });
    }
    const model = url.searchParams.get("model") ?? "grok-voice-think-fast-2.0";
    /*
     * WHICH PROVIDER. Defaults to the real one; overridable per call so a
     * test can point this bridge at a provider it controls.
     *
     * The real provider mostly behaves, which is exactly why it cannot show
     * what this code does when a provider does not — closes mid-answer,
     * never answers a commit, sends nonsense. Those paths are most of the
     * failure surface and none of them were reachable before this existed.
     */
    const grokBaseUrl = url.searchParams.get("grokBaseUrl") ?? GROK_REALTIME_URL;

    /*
     * SUPERSEDE A DIFFERENT CALL, NEVER THE SAME ONE AGAIN.
     *
     * A client that has not yet seen its acceptance re-requests, and it is
     * right to: a request can be lost, so asking again is the only way to
     * make starting a call reliable. The host CLI re-asks every few seconds
     * while a call is pending.
     *
     * Treating that re-ask as a NEW call meant a cold bridge — a dynamic
     * worker build plus a provider handshake, comfortably longer than the
     * client waits — tore down the call it was in the middle of building,
     * whereupon the client asked again and it happened again. The stream
     * recorded it exactly: call-requested, call-failed "superseded by a new
     * call", an acceptance, then "superseded by a newer bridge", and no
     * conversation at either end.
     *
     * So the same callId arriving twice is the SAME call, and the build in
     * flight is left alone to finish.
     */
    const requestedCallId = url.searchParams.get("callId");
    if (this.#endActiveCall !== null && this.#activeCallId === requestedCallId) {
      return new Response(
        JSON.stringify({ callId: requestedCallId, ok: true, reason: "already building" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (this.#endActiveCall !== null) {
      this.#endActiveCall("superseded by a new call on this stream", true);
      this.#endActiveCall = null;
      this.#activeCallId = null;
    }
    const dialGrok = async () => {
      const target = new URL(grokBaseUrl);
      target.searchParams.set("model", model);
      /*
       * The key goes to xAI and nowhere else. `grokBaseUrl` is caller-chosen,
       * and a bearer token that follows the URL anywhere is a credential
       * waiting to be exfiltrated by whoever can call startCall.
       */
      const headers: Record<string, string> = { Upgrade: "websocket" };
      if (target.hostname === "api.x.ai" || target.hostname.endsWith(".x.ai")) {
        headers.Authorization = `Bearer getSecret("${XAI_SECRET}")`;
      }
      const response = await fetch(target.toString(), { headers });
      const socket = response.webSocket;
      if (socket === null) return { listen: null, socket: null, status: response.status };
      socket.binaryType = "arraybuffer"; // before accept(): post-2025-03-17 default is Blob
      socket.accept();
      /*
       * LISTEN FROM THE INSTANT WE ACCEPT, NOT WHEN WE GET ROUND TO IT.
       *
       * accept() starts delivery, and anything delivered before a listener
       * exists is gone. Between here and attachGrok there used to be a real
       * round trip (`env.ITX.get()`), so a provider that greets promptly had
       * its session.created dropped — and session.created is the ONLY thing
       * that makes this bridge send session.update, so the handshake then
       * never completed and the call hung, silently, forever. Measured: a
       * fake provider greeting at 0ms hung startCall indefinitely while the
       * same greeting at 400ms brought the call up in 4s.
       *
       * So the real handler is installed later, but the socket is drained
       * from the first instant into a buffer that the handler inherits.
       */
      const early: MessageEvent[] = [];
      let deliver: ((event: MessageEvent) => void) | null = null;
      socket.addEventListener("message", (event) => {
        if (deliver === null) early.push(event);
        else deliver(event);
      });
      const listen = (handler: (event: MessageEvent) => void) => {
        deliver = handler;
        for (const event of early.splice(0)) handler(event);
      };
      return { listen, socket, status: response.status };
    };
    const first = await dialGrok();
    if (first.socket === null) {
      return new Response(`xai upgrade failed: ${first.status}`, { status: 502 });
    }
    /*
     * MUTABLE. The provider closes this socket on its own schedule — measured
     * at 296s into an hour-long soak, 18s after the last audio — and a call
     * that dies with it is a call that cannot last an hour. It is redialled
     * underneath the conversation instead; see attachGrok below.
     */
    let upstream = first.socket;
    /**
     * How many messages we could not hand the provider. A socket that has
     * closed but not yet fired its close event throws on send, and a throw
     * out of a stream-delivery callback takes the delivery lane with it — so
     * every send to the provider goes through here, and a failure is a
     * counter rather than an exception thrown across a callback boundary.
     */
    let sendFailures = 0;
    const sendUpstream = (message: Record<string, unknown>): boolean => {
      try {
        upstream.send(JSON.stringify(message));
        return true;
      } catch {
        sendFailures++;
        return false;
      }
    };

    // The anchor pair exists only for the socket-shaped modes; a detached
    // call has no client end at all.
    const pair = detached ? null : new WebSocketPair();
    const client = pair?.[0] ?? null;
    const server = pair?.[1] ?? null;
    if (server !== null) {
      server.binaryType = "arraybuffer";
      server.accept();
    }

    if (mode === "proxy" && server !== null && client !== null) {
      upstream.addEventListener("message", (event) => {
        try {
          server.send(event.data as ArrayBuffer | string);
        } catch {
          /* client gone; close handler tears down */
        }
      });
      server.addEventListener("message", (event) => {
        try {
          upstream.send(event.data as ArrayBuffer | string);
        } catch {
          /* upstream gone */
        }
      });
      const teardown = () => {
        try {
          upstream.close();
        } catch {}
        try {
          server.close();
        } catch {}
      };
      upstream.addEventListener("close", teardown);
      server.addEventListener("close", teardown);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (mode !== "bridge" && !detached) {
      upstream.close();
      return new Response(`unknown mode: ${mode}`, { status: 400 });
    }
    const streamPath = url.searchParams.get("path");
    if (streamPath === null || streamPath === "") {
      upstream.close();
      return new Response("bridge mode requires ?path=", { status: 400 });
    }
    const callId = url.searchParams.get("callId") ?? crypto.randomUUID().slice(0, 8);
    /*
     * Identity for THIS bridge instance. Superseding within one Durable
     * Object instance is not enough: a redeploy or an eviction leaves the
     * previous isolate holding a live Grok socket and a live subscription,
     * and both then answer the same turn — the listener hears two voices and
     * the device's buffer sees twice the audio it can play. A bridge that
     * observes a call-accepted for its own callId from a DIFFERENT bridge
     * stands down, so the newest one always wins wherever it is running.
     */
    const bridgeId = crypto.randomUUID().slice(0, 8);
    const effort = url.searchParams.get("effort") === "high" ? "high" : "none";
    const voice = url.searchParams.get("voice") ?? "eve";
    const instructions =
      url.searchParams.get("instructions") ??
      (url.searchParams.get("colleague") === "1"
        ? VOICE_INSTRUCTIONS
        : "You are a concise voice assistant. Answer in one short sentence unless asked for detail.");
    const manualTurns = url.searchParams.get("turns") === "manual";

    // One project stub for the whole call; valid because this invocation's
    // context stays open for as long as the call is doing work — the anchor
    // socket in bridge mode, the waitUntil promise in detached mode.
    let project: Awaited<ReturnType<typeof this.env.ITX.get>>;
    try {
      project = await this.env.ITX.get();
    } catch (error) {
      upstream.close();
      return new Response(`itx unavailable: ${String(error)}`, { status: 502 });
    }
    const stream = project.streams.get(streamPath);

    let spkSeq = 0;
    /*
     * Which answer the model is currently speaking, and how far into it.
     *
     * `answerSeq` counts up and never repeats within a call, which is what
     * makes a barge-in expressible as a comparison rather than as a message:
     * a listener holding speech from answer 3 rejects everything numbered 3
     * the moment it sees a 4, with no cancellation event to wait for and
     * nothing to acknowledge. `answerFrames` restarts at zero for each
     * answer so a gap is visible where it occurs.
     */
    let answerSeq = 0;
    let answerFrames = 0;
    /*
     * Audio left over from the previous provider chunk, waiting for enough of
     * the next one to make a whole 20ms frame.
     */
    let spkRemainder = new Uint8Array(0);
    let appendErrors = 0;

    /*
     * ONE ordered outbound lane.
     *
     * This used to be a bare `stream.append(...).catch()` per call — every
     * append an independent in-flight RPC, so two issued back to back could
     * commit in either order. Transcript deltas landed transposed (the
     * observed "<second half><first half>" on the device's screen), and
     * nothing about audio frame order was guaranteed either.
     *
     * Ordering is now structural: at most one append is in flight, and the
     * next starts only after it resolves. That costs nothing in throughput
     * because the queue COALESCES — whatever accumulates during a round trip
     * ships as one atomic multi-event append, so the batch grows exactly as
     * fast as latency demands. At ~50 ms RTT and 20 events per batch that is
     * ~400 events/s against the ~50/s this protocol produces.
     *
     * The alternative — awaiting each append at the call site — would block
     * the Grok socket's message handler on a full round trip per event, and
     * is what this design is avoiding.
     */
    const MAX_EVENTS_PER_APPEND = 20;
    /**
     * …and a ceiling on how much may wait, because nothing else is one.
     *
     * The provider decides how fast it speaks and this queue absorbs whatever
     * it produces: a 90-second answer arrives as 4500 events in one burst,
     * and that measurably works (all 4500 delivered, in order, in 13.8s). But
     * "measurably works at 90 seconds" is not a bound, and the failure past
     * one is a Durable Object running out of memory — which ends the call
     * with no event, no reason, and no obituary.
     *
     * ~6 minutes of speech in hand is far past any answer a person will sit
     * through, so this never fires in a healthy call. When it does, the
     * OLDEST audio goes: a listener holding a queue that deep has long since
     * stopped caring about the beginning of it, and the count rides out on
     * call-ended so the drop is never silent.
     */
    const MAX_QUEUED_EVENTS = 20_000;
    const outbound: Parameters<typeof stream.append> = [];
    let droppedSpk = 0;
    let draining = false;
    const drainOutbound = async () => {
      if (draining) return;
      draining = true;
      try {
        while (outbound.length > 0) {
          const batch = outbound.splice(0, MAX_EVENTS_PER_APPEND);
          try {
            await stream.append(...batch);
          } catch {
            appendErrors++;
            // Losing a batch atomically can swallow response.created or
            // response.done and leave the device's transcript accumulator
            // dirty. Retry once, at the head, so ordering survives.
            if (appendErrors < 50) outbound.unshift(...batch);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      } finally {
        draining = false;
      }
    };
    const fireAppend = (...events: Parameters<typeof stream.append>) => {
      outbound.push(...events);
      if (outbound.length > MAX_QUEUED_EVENTS) {
        /* Drop the oldest SPEAKER frames only. Transcripts and lifecycle
         * events are what a listener reasons with, and there are never
         * enough of them to be the thing filling this queue. */
        for (let index = 0; index < outbound.length && outbound.length > MAX_QUEUED_EVENTS; ) {
          if ((outbound[index] as { type?: string })?.type === "voicelab/spk-frame") {
            outbound.splice(index, 1);
            droppedSpk++;
          } else {
            index++;
          }
        }
      }
      void drainOutbound();
    };

    /*
     * THE SERVER DOES NOT PACE. THE LISTENER OWNS THE CLOCK.
     *
     * This is where a drip-feed used to be, and it is worth recording why it
     * is gone rather than tuned. Pacing here is a server guessing at a
     * network it cannot see, and every version of the guess was audible:
     *
     *   2x realtime      a 60s answer left 30s queued, which overran the
     *                    device's buffer and shredded the waveform;
     *   +5% drift        3s accumulated over an answer, same result;
     *   exact realtime   the buffer hovered at the prefill mark and any
     *                    jitter emptied it — 45 starves in 3099 frames, each
     *                    inserting 160ms of silence, ~7s of stutter a minute;
     *   realtime + lead  every value of the lead was wrong for some network,
     *                    and picking one traded overflow for starvation.
     *
     * Only the listener knows how much audio it is holding. So frames leave
     * as fast as the wire takes them, and the device buffers a whole answer
     * and plays it on its own clock. That deletes the entire class of defect
     * above, and it makes barge-in instant: discarding queued speech becomes
     * a local act needing no round trip.
     *
     * What replaces pacing is IDENTITY. Every frame says which call, which
     * answer, and which frame within that answer, so a listener can decide —
     * with no clock and no server cooperation — whether a frame is speech it
     * still wants, speech from an answer that has been talked over, or one
     * it has already played. See components/core/src/audio_playout.c.
     */
    /*
     * G.711 mu-law, PCM16 to 8 bits, halving the downlink.
     *
     * The uplink already does this and had to: a microcontroller could not
     * put its microphone on the wire as PCM16 base64 without stalling its own
     * TCP flow. The downlink is the same wire in the other direction and the
     * device is the same microcontroller — measured receiving 9-31 frames a
     * second against the 50 realtime needs, and concealing the shortfall.
     * ~950 bytes per 20ms frame becomes ~520.
     */
    const mulawFromPcm16 = (pcm: Uint8Array): Uint8Array => {
      const BIAS = 0x84;
      const CLIP = 32635;
      const samples = pcm.length >> 1;
      const out = new Uint8Array(samples);
      for (let index = 0; index < samples; index++) {
        let sample = ((pcm[index * 2]! | (pcm[index * 2 + 1]! << 8)) << 16) >> 16;
        const sign = sample < 0 ? 0x80 : 0;
        if (sample < 0) sample = -sample;
        if (sample > CLIP) sample = CLIP;
        sample += BIAS;
        let exponent = 7;
        for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--) {
          mask >>= 1;
        }
        const mantissa = (sample >> (exponent + 3)) & 0x0f;
        out[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
      }
      return out;
    };

    const appendSpkPcm = (bytes: Uint8Array, tGrok: number) => {
      /*
       * Re-chunked to 20ms events so a constrained consumer with a bounded
       * inbox can take them a few at a time. `answer` and `frame` are the
       * whole contract: `answer` counts up every time the model starts
       * speaking, so a listener rejects a superseded answer by comparing two
       * integers, and `frame` restarts at zero within each answer, so a hole
       * is visible where it happens rather than inferred from a total.
       *
       * `t` and `tGrok` are for measuring the network. They are deliberately
       * NOT what the playback decision is made from: the device has no
       * synchronised clock, so "is this late?" is a question only its own
       * buffer depth can answer.
       */
      /*
       * WHOLE FRAMES ONLY, so the remainder of one provider chunk joins the
       * front of the next.
       *
       * The provider's chunks are not multiples of 20ms, so slicing each one
       * at 640-byte boundaries left a SHORT final frame per chunk — and a
       * listener that requires whole frames (which it must: a partial write
       * shifts the 16-bit sample grid and every frame after it clicks)
       * rejected each one. Measured at 2.4% of frames, which then showed up
       * as a hole in the sequence and read for hours like packet loss.
       */
      const pending = spkRemainder.length + bytes.length;
      const joined = new Uint8Array(pending);
      joined.set(spkRemainder, 0);
      joined.set(bytes, spkRemainder.length);
      const whole = pending - (pending % 640);
      spkRemainder = joined.subarray(whole);
      const events = [];
      for (let offset = 0; offset < whole; offset += 640) {
        events.push({
          type: "voicelab/spk-frame",
          ephemeral: true as const,
          payload: {
            callId,
            answer: answerSeq,
            frame: answerFrames++,
            seq: spkSeq++,
            t: Date.now(),
            tGrok,
            enc: "u",
            pcm: bytesToBase64(mulawFromPcm16(joined.subarray(offset, offset + 640))),
          },
        });
      }
      if (events.length === 0) return;
      fireAppend(...events);
    };
    /*
     * THE BACK OFFICE.
     *
     * A text agent in this project that hears the whole conversation and is
     * messaged by the voice whenever something needs to be right. Two lanes,
     * and the split is the entire idea:
     *
     *   listening  every finished transcript line is appended to the agent as
     *              context with "dont-trigger-request". It accumulates the
     *              conversation without ever being asked to respond to it, so
     *              when it IS asked it already knows what was said — and no
     *              LLM request is spent on a customer who is only chatting.
     *
     *   messaging  message_back_office appends what the voice sent and lets
     *              the agent take its turn. This does NOT block the voice: the
     *              tool output returns immediately so it can say "I've sent
     *              that on", and whatever the back office sends — one message
     *              or five, in any order — is pushed into the session as it
     *              arrives, as a new conversation item.
     *
     * Everything here is fire-and-forget against the call's lifetime. The
     * back office is a bonus, and a bonus must never be able to stall a voice.
     */
    const backOffice = url.searchParams.get("colleague") === "1";
    const backOfficeAgent = project.agents.get(COLLEAGUE_PATH);
    /** Messages sent to the back office, and messages heard back. */
    let sentCount = 0;
    let backOfficeHeard = 0;
    /*
     * The agent is long-lived and its stream holds every message it has ever
     * sent, so anything stamped before this moment belongs to somebody else's
     * conversation and must not be read out in this one.
     */
    const backOfficeSince = Date.now();
    /**
     * Born and briefed, once per call, before anything is appended to it.
     *
     * Setup does this too, but setup is not the only way a call starts: a
     * direct `startCall`, a `mode=bridge` host, or a project where nobody ran
     * setup all land here with an agent that may not exist.
     */
    let backOfficeReady: Promise<boolean> | null = null;
    const ensureBackOfficeOnce = () => {
      backOfficeReady ??= ensureBackOffice(backOfficeAgent).then(
        () => true,
        (error: unknown) => {
          console.log(`colleague unavailable: ${String(error)}`);
          return false;
        },
      );
      return backOfficeReady;
    };
    /** Give the back office a line of the conversation, without waking it. */
    const overhear = (who: "customer" | "voice", text: string) => {
      if (!backOffice || text.trim().length === 0) return;
      this.ctx.waitUntil(
        (async () => {
          if (!(await ensureBackOfficeOnce())) return;
          await backOfficeAgent
            .append({
              payload: {
                content: `${who === "customer" ? "Customer" : "The front office"} said: ${text}`,
                /*
                 * The whole point: context, not a prompt. Without this the
                 * colleague would take a turn on every sentence spoken in the
                 * room — an LLM request per utterance, and an assistant
                 * talking over itself.
                 */
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
                role: "developer",
              },
              type: "events.iterate.com/agents/context-added",
            })
            .catch(() => {});
        })(),
      );
    };
    /*
     * A MESSAGE BUS, NOT A QUESTION AND AN ANSWER.
     *
     * This was built as request/response — one question in flight, wait for
     * its reply, correlate the two — and every hard problem in it came from
     * that shape rather than from the platform.
     *
     * The back office is another agent, not a function. It may answer in one
     * message or five, answer the second message before the first, say
     * nothing at all, ask a question BACK, or volunteer something nobody
     * asked for. `agent.ask()` models none of that: it waits for the agent's
     * next message after its own append, so with two questions outstanding
     * both resolve with the first reply — measured at 22 questions sharing
     * one answer, 21 real answers never spoken.
     *
     * So nothing here correlates anything. Messages go out; every message the
     * back office sends comes in and is spoken. The NUMBERS are not a
     * correlation mechanism — they are a courtesy between two language
     * models, so the voice can say which message it is reading from and the
     * back office can say which one it is replying to. Neither this code nor
     * the platform ever has to be right about the pairing, which is the only
     * reason the pairing stops being a source of bugs.
     */
    /** Back-office messages waiting for a gap in the conversation. */
    const deliverQueue: string[] = [];
    let delivering = false;

    const pumpDelivery = async () => {
      if (delivering) return;
      delivering = true;
      try {
        while (deliverQueue.length > 0 && !closedDown) {
          const text = deliverQueue.shift()!;
          /*
           * Wait for a gap. A message arriving while the assistant is
           * mid-sentence, or while the customer is still holding the talk
           * button, would put its response.create into a turn already in
           * flight — two answers interleaved, which is the corruption this
           * lab has heard before from two bridges.
           */
          for (let waited = 0; (responseActive || micOpen) && waited < 60_000; waited += 250) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (closedDown) return;
          /*
           * A plain conversation item and a fresh response, NOT a tool
           * output: by now the voice has long since spoken, so this has to
           * interrupt the way a colleague putting their head round the door
           * does.
           */
          sendUpstream({
            item: {
              content: [{ text: `The back office says: ${text}`, type: "input_text" }],
              role: "user",
              type: "message",
            },
            type: "conversation.item.create",
          });
          sendUpstream({ type: "response.create" });
          /* Let that be spoken before the next one interrupts it. */
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        delivering = false;
      }
    };

    /*
     * EVERY message the back office sends, forwarded — not the one some ask
     * happens to be waiting for.
     *
     * Its own stream is where its outbound messages land, so this is an
     * ordinary session connection on that stream. Messages from before this
     * call began are somebody else's conversation: the agent is long-lived
     * and its stream holds every message it has ever sent.
     */
    const watchBackOffice = async () => {
      if (!backOffice) return;
      try {
        await project.streams.get(COLLEAGUE_PATH).openConnection({
          connectionKey: `voicelab-back-office-${callId}`,
          eventTypes: ["events.iterate.com/agents/web-message-sent"],
          processEventBatch: (batch: { events: { createdAt: string; payload?: unknown }[] }) => {
            for (const event of batch.events) {
              if (Date.parse(event.createdAt) < backOfficeSince) continue;
              const text = (event.payload as { message?: string })?.message ?? "";
              if (text.trim().length === 0) continue;
              backOfficeHeard++;
              fireAppend({
                ephemeral: true,
                payload: { callId, direction: "in", heard: backOfficeHeard, text },
                type: "voicelab/back-office-message",
              });
              deliverQueue.push(text);
              void pumpDelivery();
            }
          },
        });
      } catch (error) {
        console.log(`back office not watchable: ${String(error)}`);
      }
    };

    if (backOffice) this.ctx.waitUntil(watchBackOffice());

    /**
     * Send one message to the back office and return its number.
     *
     * The number is a label for the two models to talk about, nothing more.
     * Delivery is fire-and-forget against the call's lifetime: the back
     * office is a bonus, and a bonus must never be able to stall a voice.
     */
    const messageBackOffice = (text: string): number => {
      const number = ++sentCount;
      fireAppend({
        ephemeral: true,
        payload: { callId, direction: "out", number, text },
        type: "voicelab/back-office-message",
      });
      this.ctx.waitUntil(
        (async () => {
          if (!(await ensureBackOfficeOnce())) return;
          await backOfficeAgent
            .append({
              payload: {
                content: `Message #${number} from the front office: ${text}`,
                role: "user",
              },
              type: "events.iterate.com/agents/context-added",
            })
            .catch((error: unknown) => {
              console.log(`back office unreachable: ${String(error)}`);
            });
        })(),
      );
      return number;
    };

    /** Function calls arrive twice on some paths; answer each exactly once. */
    const answeredToolCalls = new Set<string>();
    const handleToolCall = (id: string, name: string, argumentsJson: string) => {
      if (name !== "message_back_office" || answeredToolCalls.has(id)) return;
      answeredToolCalls.add(id);
      let text = "";
      try {
        text = String((JSON.parse(argumentsJson || "{}") as { text?: unknown }).text ?? "");
      } catch {
        text = argumentsJson;
      }
      /*
       * Answer the TOOL immediately, before the back office has read anything.
       * A voice model waiting on a function output is a voice model saying
       * nothing, and thirty seconds of nothing is a dropped call as far as
       * anyone listening can tell.
       *
       * The number is what the reply is for: replies arrive later, out of
       * order, possibly several to one message and possibly about nothing
       * that was sent at all, and a voice that cannot name which thread it is
       * picking up sounds like it has lost the plot.
       */
      const number = messageBackOffice(text);
      sendUpstream({
        item: {
          call_id: id,
          output: JSON.stringify({
            status: "sent",
            tell_the_customer: `sent as message #${number} - the back office will reply when it has something. you can tell the human to wait or speak about something else`,
          }),

          type: "function_call_output",
        },
        type: "conversation.item.create",
      });
      sendUpstream({ type: "response.create" });
    };

    // Resolves when Grok has accepted the session — what `startCall` waits
    // for, so a caller that gets an answer knows the call is really live.
    let markReady: (ready: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const sessionReady = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      markReady = resolve;
    });
    let lastActivityAt = Date.now();
    /** True once a session has ever been fully established on this call. */
    let everReady = false;
    let responseActive = false;
    /** True between a turn's start and its commit: the customer is speaking. */
    let micOpen = false;
    /** Mic frames and expanded PCM bytes that ARRIVED here this turn. */
    let micFrames = 0;
    let micBytes = 0;
    /**
     * …and what was actually handed to the provider. Not the same number.
     *
     * `turn-committed` exists to answer "was the provider given anything?",
     * and it used to answer with what arrived at this bridge — so a turn
     * where every real frame was discarded by the reassembler still reported
     * a confident "50 frames, 32000 bytes, 1000ms". The one event whose job
     * is to tell those two cases apart was reporting the case it could not
     * see.
     */
    let micDeliveredFrames = 0;
    let micDeliveredBytes = 0;

    /*
     * REASSEMBLING THE MICROPHONE, BECAUSE THE WIRE DOES NOT PROMISE ORDER.
     *
     * A device holding the talk button appends frames as fast as it can and
     * does not wait for one to land before sending the next — that is the
     * only way to keep 50 frames a second moving over a link with a 90ms
     * round trip. But every append is an INDEPENDENT Durable Object call, so
     * two issued back to back can commit in either order. (Measured on this
     * very stream: transcript deltas arrived transposed.) A device could
     * serialise its appends instead, and would then be limited to one frame
     * per round trip: about 11 frames a second where it needs 50.
     *
     * So order is carried in the payload rather than demanded of the wire.
     * Frames arriving early wait here until the gap in front of them is
     * filled; the provider's audio buffer is append-only and a transposed
     * pair is a transposed 40ms of speech, which is a stutter in the middle
     * of a word.
     *
     * The window is deliberately small. A hole that never fills must not
     * hold up a whole turn, so once this many frames are waiting the oldest
     * missing one is declared lost and the queue drains past it — a 20ms
     * dropout, versus a turn that never commits.
     */
    const MIC_REORDER_WINDOW = 16;
    /*
     * …and a frame numbered further ahead than this is not a reordering, it
     * is a frame from a DIFFERENT TURN.
     *
     * Every turn numbers its frames from zero, so the tail of turn 1 still in
     * flight when turn 2 starts arrives carrying numbers hundreds above what
     * turn 2 is sending. Those went into the reorder window, overflowed it,
     * and dragged `micExpected` up to the straggler's number — after which
     * every genuine frame of the new turn was "already sent, or already given
     * up on" and dropped. Measured: the customer spoke 30 frames, the
     * provider was handed 20 frames of the PREVIOUS utterance and none of the
     * new one, and the turn was answered as if it had been heard.
     *
     * A second and a bit of lead is more reordering than any wire produces.
     * Beyond it, the frame belongs to a turn that is over.
     */
    const MIC_MAX_LEAD = 64;
    let micExpected = 0;
    const micPending = new Map<number, ArrayBuffer | Uint8Array>();
    let micReordered = 0;
    let micLate = 0;
    let micLost = 0;
    /** Frames rejected as belonging to a turn that has already finished. */
    let micStale = 0;

    const sendMic = (pcm: ArrayBuffer | Uint8Array) => {
      try {
        upstream.send(pcm as ArrayBuffer);
        micDeliveredFrames++;
        micDeliveredBytes += pcm.byteLength;
      } catch {
        sendFailures++;
      }
    };
    /** Hand over every frame that is now contiguous, in order. */
    const drainMic = () => {
      for (;;) {
        const next = micPending.get(micExpected);
        if (next === undefined) return;
        micPending.delete(micExpected);
        micExpected++;
        sendMic(next);
      }
    };
    const offerMic = (sequence: number, pcm: ArrayBuffer | Uint8Array) => {
      if (sequence < micExpected) {
        /* Already sent, or already given up on. Playing it now would insert
         * a fragment of the past into the middle of the present. */
        micLate++;
        return;
      }
      if (sequence > micExpected + MIC_MAX_LEAD) {
        /* Not reordering — a leftover from a turn that has already ended. */
        micStale++;
        return;
      }
      if (sequence === micExpected) {
        micExpected++;
        sendMic(pcm);
        drainMic();
        return;
      }
      micReordered++;
      micPending.set(sequence, pcm);
      while (micPending.size > MIC_REORDER_WINDOW) {
        /* Give up on the frame at the front and take the next one we have. */
        const lowest = Math.min(...micPending.keys());
        micLost += lowest - micExpected;
        micExpected = lowest;
        drainMic();
      }
    };
    /**
     * The turn is over, so nothing more is coming to fill the gaps. Anything
     * still waiting is sent in order — late speech is better than missing
     * speech, and the provider has not been asked to answer yet.
     */
    const flushMic = () => {
      const waiting = [...micPending.keys()].sort((left, right) => left - right);
      for (const sequence of waiting) {
        const pcm = micPending.get(sequence);
        micPending.delete(sequence);
        if (pcm !== undefined) sendMic(pcm);
      }
      micExpected = 0;
      micPending.clear();
    };

    /*
     * What has been said, so a redialled session does not start amnesiac.
     * Bounded: this is context for continuity, not a transcript store, and
     * an hour of talking must not grow an unbounded array in a DO.
     */
    const history: { role: "assistant" | "user"; text: string }[] = [];
    const remember = (role: "assistant" | "user", text: string) => {
      if (text.trim().length === 0) return;
      history.push({ role, text });
      if (history.length > 24) history.splice(0, history.length - 24);
    };
    let grokGeneration = 0;
    let redials = 0;

    /** Provider frames we could not read, and handler throws we swallowed. */
    let providerJunk = 0;
    let handlerErrors = 0;
    /**
     * Nothing the provider says may be allowed to throw out of here.
     *
     * This handler runs as a WebSocket event listener inside the invocation
     * that owns the whole call. An exception escaping it does not just lose
     * one frame: measured, ONE truncated JSON frame ended the call outright —
     * no more audio, no answer to the next turn the customer spoke, no
     * redial, and no call-ended, so the listener was never told anything had
     * happened. A provider is allowed to send rubbish; it is not allowed to
     * hang up on the customer by doing it.
     */
    const onGrokMessage = (event: MessageEvent) => {
      try {
        handleGrokMessage(event);
      } catch (error) {
        handlerErrors++;
        console.log(`grok handler threw: ${String(error)}`);
      }
    };
    const handleGrokMessage = (event: MessageEvent) => {
      const tGrok = Date.now();
      lastActivityAt = tGrok;
      if (typeof event.data !== "string") {
        appendSpkPcm(new Uint8Array(event.data as ArrayBuffer), tGrok);
        return;
      }
      let grokEvent: { type: string; delta?: string };
      try {
        grokEvent = JSON.parse(event.data) as { type: string; delta?: string };
      } catch {
        providerJunk++;
        return;
      }
      if (typeof grokEvent?.type !== "string") {
        providerJunk++;
        return;
      }
      if (grokEvent.type === "session.created") {
        sendUpstream({
          type: "session.update",
          session: {
            voice,
            instructions,
            /*
             * ONE tool, on purpose. A voice model choosing between many
             * tools is a voice model pausing, and every pause is audible;
             * choosing whether to ask a colleague is a judgement it can
             * make in the time it takes to say "let me check".
             */
            ...(backOffice
              ? {
                  tool_choice: "auto",
                  tools: [
                    {
                      description:
                        "Send a message to the back office — a careful expert with access " +
                        "to the customer's systems, who does anything that needs real " +
                        "thought, knowledge, or action. Use it to ask, to answer a " +
                        "question they asked you, or to pass anything along. It returns " +
                        "immediately: they are reading, not replying. Keep talking to the " +
                        "customer meanwhile. Their messages arrive as 'The back office " +
                        "says', whenever they have something, in any number.",
                      name: "message_back_office",
                      parameters: {
                        properties: {
                          text: {
                            description:
                              "What to say to them. They can hear the conversation, but " +
                              "write it so it stands on its own.",
                            type: "string",
                          },
                        },
                        required: ["text"],
                        type: "object",
                      },
                      type: "function",
                    },
                  ],
                }
              : {}),
            reasoning: { effort },
            /*
             * Manual turns mean no VAD anywhere: the device decides when a
             * turn starts and ends (push to talk), and this bridge turns
             * those edges into commit/response.create. Server VAD on an
             * open microphone next to a speaker hears the answer and
             * answers itself.
             */
            turn_detection: manualTurns
              ? { type: null }
              : { type: "server_vad", threshold: 0.5, silence_duration_ms: 500 },
            audio: {
              input: { format: { type: "audio/pcm", rate: 16000 }, transport: "binary" },
              output: { format: { type: "audio/pcm", rate: 16000 }, transport: "binary" },
            },
          },
        });
        return;
      }
      if (grokEvent.type === "session.updated") {
        /*
         * On a redial, hand the new session what was already said. Without
         * this the model wakes with no memory mid-conversation, and the
         * customer — who noticed nothing — is talking to someone who just
         * walked in. Bounded to the recent turns; this is continuity, not a
         * transcript store.
         */
        if (history.length > 0) {
          sendUpstream({
            item: {
              content: [
                {
                  text:
                    "This conversation is already in progress; you were briefly " +
                    "disconnected and the customer did not notice. It so far:\n" +
                    history
                      .map((line) => `${line.role === "user" ? "Customer" : "You"}: ${line.text}`)
                      .join("\n") +
                    "\n\nCarry on. Do not greet them or mention any interruption.",
                  type: "input_text",
                },
              ],
              role: "user",
              type: "message",
            },
            type: "conversation.item.create",
          });
        }
        fireAppend({
          type: "voicelab/call-accepted",
          payload: {
            bridge: detached ? "worker-detached" : "worker",
            bridgeId,
            callId,
            model,
            redials,
          },
        });
        /*
         * No greeting. A device that starts talking the moment a call opens
         * collides with a user who is already speaking — and with manual
         * turns there is no VAD to sort that out, so the opening turn was
         * routinely mangled. It waits to be spoken to.
         */
        everReady = true;
        markReady({ ok: true });
        return;
      }
      if (grokEvent.type === "response.output_audio.delta" && grokEvent.delta !== undefined) {
        appendSpkPcm(new Uint8Array(base64ToBytes(grokEvent.delta)), tGrok);
        return;
      }
      if (grokEvent.type === "response.output_audio_transcript.done") {
        remember("assistant", (grokEvent as { transcript?: string }).transcript ?? "");
      }
      if (grokEvent.type === "conversation.item.input_audio_transcription.completed") {
        remember("user", (grokEvent as { transcript?: string }).transcript ?? "");
      }
      /*
       * The colleague listens through the same transcript the screen shows.
       * Only FINISHED lines: deltas would fill its context with fragments of
       * half-spoken sentences.
       */
      if (backOffice) {
        const full = grokEvent as {
          type: string;
          transcript?: string;
          item?: { content?: { transcript?: string; text?: string }[] };
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        if (full.type === "response.output_audio_transcript.done") {
          overhear("voice", full.transcript ?? "");
        }
        if (full.type === "conversation.item.input_audio_transcription.completed") {
          overhear("customer", full.transcript ?? "");
        }
        if (full.type === "response.function_call_arguments.done") {
          handleToolCall(full.call_id ?? "", full.name ?? "", full.arguments ?? "{}");
        }
        /*
         * Belt and braces: some realtime implementations only surface the
         * finished call in the response, and a tool that silently never fires
         * is indistinguishable from a model that chose not to use it.
         */
        if (full.type === "response.done") {
          const output = (grokEvent as unknown as { response?: { output?: unknown[] } }).response
            ?.output;
          for (const item of Array.isArray(output) ? output : []) {
            const call = item as {
              type?: string;
              name?: string;
              call_id?: string;
              id?: string;
              arguments?: string;
            };
            if (call.type === "function_call") {
              handleToolCall(
                call.call_id ?? call.id ?? "",
                call.name ?? "",
                call.arguments ?? "{}",
              );
            }
          }
        }
      }
      if (grokEvent.type === "response.created") {
        responseActive = true;
        /*
         * A NEW ANSWER. Everything the listener is still holding belongs to
         * the previous one, and this number is the whole instruction to drop
         * it — no cancellation event to deliver, nothing to acknowledge, and
         * no way for the instruction to arrive out of order relative to the
         * speech it governs, because it IS the speech's own label.
         */
        answerSeq++;
        answerFrames = 0;
        /* A new answer starts on a frame boundary: carrying the remainder
         * across would put the tail of the last one at the head of this. */
        spkRemainder = new Uint8Array(0);
      }
      if (grokEvent.type === "response.done") responseActive = false;
      if (FORWARDED_GROK_EVENTS.has(grokEvent.type)) {
        /*
         * Transcripts and lifecycle events go out immediately, like the audio
         * they describe. When the audio was paced these had to be queued
         * behind it or `response.done` overtook the answer still waiting to
         * be sent — the device showed "ready, hold to talk" while it was
         * still speaking. Nothing is queued here any more, so the ordering
         * problem that required it is gone with it.
         */
        /*
         * FORWARD THE EVENT, NOT THE PROVIDER'S WHOLE RESPONSE OBJECT.
         *
         * `response.done` carries the complete response - every output item,
         * its content, usage accounting - and is by a wide margin the largest
         * thing this device is ever sent. The device parses JSON into a fixed
         * token pool and takes each batch into a fixed inbox slot, so one
         * oversized event does not truncate: it fails the whole BATCH, and
         * every event travelling with it is lost.
         *
         * That is a listener whose speaker works perfectly and whose screen
         * never leaves "thinking", because the completion it is waiting for
         * is the one event too big to arrive. Nothing downstream reads the
         * response body; the type, the item and the transcript are the whole
         * contract.
         */
        const slim = grokEvent as Record<string, unknown>;
        fireAppend({
          type: "voicelab/grok-event" as const,
          ephemeral: true as const,
          payload: {
            callId,
            answer: answerSeq,
            t: Date.now(),
            event: {
              type: slim.type,
              ...(slim.delta === undefined ? {} : { delta: slim.delta }),
              ...(slim.transcript === undefined ? {} : { transcript: slim.transcript }),
              ...(slim.item_id === undefined ? {} : { item_id: slim.item_id }),
              ...(slim.name === undefined ? {} : { name: slim.name }),
              ...(slim.call_id === undefined ? {} : { call_id: slim.call_id }),
              ...(slim.arguments === undefined ? {} : { arguments: slim.arguments }),
              ...(slim.item === undefined ? {} : { item: slim.item }),
            },
          },
        });
      }
    };

    /*
     * Wire a Grok socket into this call. Called for the first one and for
     * every redial, so a replacement is indistinguishable from the original
     * everywhere else in this file — the only thing that knows a redial
     * happened is the session.updated handler, which replays the
     * conversation so far.
     */
    const attachGrok = (
      dialed: { socket: WebSocket; listen: (handler: (event: MessageEvent) => void) => void },
      generation: number,
    ) => {
      dialed.listen(onGrokMessage);
      dialed.socket.addEventListener("close", (event) => {
        // A socket that has already been replaced closes on its way out.
        if (generation !== grokGeneration || closedDown) return;
        void redialGrok(`grok closed ${event.code}`);
      });
    };

    /*
     * The provider hangs up; the CALL does not.
     *
     * Measured: the socket closed 296s into an hour-long soak, 18s after the
     * last audio, and everything downstream treated it as the end of the
     * conversation — the bridge tore down, the device cleared its intent, and
     * 55 minutes of soak ran against nothing. A call that cannot outlive its
     * provider's socket cannot last an hour.
     *
     * So the socket is replaced under the conversation. session.update is
     * re-sent by the ordinary session.created path, and what was said so far
     * is replayed as conversation items, so the model picks the thread back
     * up rather than greeting a stranger.
     */
    const redialGrok = async (reason: string) => {
      if (closedDown) return;
      redials++;
      /* Bounded: a provider refusing us forever must end the call, not spin. */
      if (redials > 40) return teardown(`${reason}; redialled ${redials} times`);
      fireAppend({
        ephemeral: true,
        payload: { bridgeId, callId, reason, redials },
        type: "voicelab/bridge-redialling",
      });
      responseActive = false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * redials, 5000)));
      if (closedDown) return;
      const next = await dialGrok().catch(() => ({ listen: null, socket: null, status: 0 }));
      if (next.socket === null || next.listen === null) {
        console.log(`redial failed (${next.status}); retrying`);
        return void redialGrok(`redial failed ${next.status}`);
      }
      grokGeneration++;
      upstream = next.socket;
      attachGrok({ listen: next.listen, socket: next.socket }, grokGeneration);
    };

    attachGrok({ listen: first.listen!, socket: upstream }, grokGeneration);

    // Live subscription for mic frames + control. Session connections die
    // silently (push budget ~1000, DO resets), so recycle make-before-break
    // on a batch budget and on delivery silence while the call is active.
    let generation = 0;
    let currentConnection: { close(): void } | null = null;
    let currentBatches = 0;
    /*
     * When a PEER last spoke to us — a mic frame, a turn edge, a ping. Not
     * the same thing as "a batch arrived": the platform's own connection
     * bookkeeping is not delivered here, and an idle call legitimately
     * carries no traffic at all for minutes.
     */
    let heardFromPeerAt = Date.now();
    /** A peer that pings is one whose silence means something. */
    let pingsSeen = 0;
    /**
     * Recycles since a peer was last heard.
     *
     * A recycle replaces a delivery lane believed dead. If replacing it does
     * not bring the peer back, the peer is gone and no further lane will
     * help — but nothing said so, so a bridge whose client had exited simply
     * reopened its connection every second until the ten-minute idle
     * timeout. Measured on one stream: 196 connection-opened events and a
     * generation counter at g193, all after the client process had ended.
     * Worse than the churn, that bridge still holds the call, so the NEXT
     * call on the stream is superseded on arrival and the operator sees a
     * conversation that will not start for reasons nothing reports.
     */
    let recyclesWithoutPeer = 0;
    let lastSeenOffset = -1;
    /** Events on this stream that belong to some other call. */
    let strayEvents = 0;
    /** True once the peer driving this call has used our callId. */
    let sawOwnCallId = false;
    let reconnects = 0;
    let opening = false;
    let closedDown = false;

    const handleEvents = (events: { type: string; offset: number; payload?: unknown }[]) => {
      currentBatches++;
      for (const event of events) {
        if (event.offset <= lastSeenOffset) continue;
        lastSeenOffset = event.offset;
        // Everything delivered here was appended by a peer, by definition:
        // the subscription only names voicelab/* types.
        heardFromPeerAt = Date.now();
        recyclesWithoutPeer = 0;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        /*
         * A CALL BELONGS TO ITS callId.
         *
         * `call-ended` and `call-accepted` were checked; the events that
         * actually drive the conversation were not, so anything able to
         * append to this stream could put words in the assistant's mouth and
         * commit turns on somebody else's call — proven with a plain
         * `voicelab/say` carrying a made-up callId. The realistic source is
         * not an attacker but arithmetic: a redeploy or an eviction can leave
         * a previous bridge running, the device opens a new call with a new
         * callId on the SAME stream, and the old bridge — which only stands
         * down for its OWN callId — happily consumes the new call's
         * microphone and answers alongside. That is the "assistant replied
         * two or three times to one turn" this lab has already heard.
         *
         * The rule CALIBRATES ITSELF rather than being asserted, because the
         * peers are not all in this repository: `voicelab/say` from a script
         * has never carried a callId, and a firmware that stamps something
         * else would be struck deaf by a filter that simply demanded a
         * match. So nothing is rejected until this bridge has heard its own
         * callId at least once from the peer actually driving it. A peer that
         * does not use callIds is never second-guessed; one that does gets
         * everybody else's traffic filtered out from that moment on — which
         * is exactly when a second bridge on this stream becomes audible.
         */
        if (payload.callId === callId) sawOwnCallId = true;
        else if (
          sawOwnCallId &&
          typeof payload.callId === "string" &&
          event.type !== "voicelab/call-accepted"
        ) {
          strayEvents++;
          continue;
        }
        switch (event.type) {
          case "voicelab/mic-frame": {
            lastActivityAt = Date.now();
            micFrames++;
            try {
              /*
               * `enc: "u"` is G.711 mu-law, which is how a microcontroller
               * gets its microphone onto the wire at all: PCM16 base64 is
               * ~100 KB/s and stalled the device's TCP flow outright. Half
               * the bytes, expanded back here so the provider only ever sees
               * PCM16.
               */
              const bytes = base64ToBytes(payload.pcm as string);
              const pcm = payload.enc === "u" ? mulawToPcm16(bytes) : bytes;
              micBytes += pcm.byteLength;
              offerMic(typeof payload.seq === "number" ? payload.seq : micExpected, pcm);
            } catch {
              /* upstream closing; teardown follows via close event */
            }
            break;
          }
          case "voicelab/say": {
            /*
             * A turn made of text rather than speech: the same commit and
             * response the microphone path produces, so anything that can
             * append to this stream can make the device talk — and a long
             * answer can be provoked on demand for measurement.
             */
            lastActivityAt = Date.now();
            const text = typeof payload.text === "string" ? payload.text.trim() : "";
            if (text.length === 0 || text.length > 4096) break;
            if (responseActive) {
              sendUpstream({ type: "response.cancel" });
              responseActive = false;
            }
            sendUpstream({
              item: {
                content: [{ text, type: "input_text" }],
                role: "user",
                type: "message",
              },
              type: "conversation.item.create",
            });
            sendUpstream({ type: "response.create" });
            break;
          }
          case "voicelab/turn": {
            lastActivityAt = Date.now();
            if (payload.action === "start") {
              micOpen = true;
              micFrames = 0;
              micBytes = 0;
              micDeliveredFrames = 0;
              micDeliveredBytes = 0;
              /* Each turn numbers its frames from zero. */
              micExpected = 0;
              micPending.clear();
              /*
               * The person has started speaking over the answer. There is
               * nothing queued here to discard any more — the listener
               * already dropped its own queue the instant the button went
               * down, without waiting to be told. Cancelling upstream stops
               * the model generating more; the answer number it has already
               * spent is what keeps the frames still in flight from being
               * played.
               */
              if (responseActive) {
                sendUpstream({ type: "response.cancel" });
                responseActive = false;
              }
            } else if (payload.action === "commit") {
              micOpen = false;
              /* Nothing more is coming to fill the gaps, so send what waited
               * BEFORE asking the provider to answer — a frame handed over
               * after the commit is speech the answer never heard. */
              flushMic();
              sendUpstream({ type: "input_audio_buffer.commit" });
              sendUpstream({ type: "response.create" });
              /*
               * What the provider was actually given for this turn. A device
               * that speaks and hears nothing back is either not reaching
               * here (arrived 0) or being answered badly (frames fine) — and
               * without this number those two look the same from the outside.
               *
               * `frames`/`bytes`/`ms` are what the PROVIDER got. `arrived` is
               * what reached this bridge. When they disagree the reassembler
               * threw speech away, and that gap is the whole diagnosis.
               */
              fireAppend({
                type: "voicelab/turn-committed",
                ephemeral: true,
                payload: {
                  bridgeId,
                  callId,
                  frames: micDeliveredFrames,
                  bytes: micDeliveredBytes,
                  ms: Math.round(micDeliveredBytes / 32),
                  arrived: micFrames,
                  arrivedBytes: micBytes,
                  /* Out-of-order arrivals are expected and harmless; LOST
                   * frames are the number that matters, and a rising `late`
                   * means the device is re-sending what we already used.
                   * `stale` counts frames from a turn that already ended. */
                  reordered: micReordered,
                  late: micLate,
                  lost: micLost,
                  stale: micStale,
                },
              });
            }
            break;
          }
          case "voicelab/ping":
            /*
             * The pong is this bridge's proof of life, and the only event a
             * device receives during a silent call. A detached call lives in
             * a Durable Object that can be evicted or replaced without ever
             * running its teardown, so "no call-ended arrived" is NOT
             * evidence that the call is alive — the pong is.
             */
            pingsSeen++;
            fireAppend({
              type: "voicelab/pong",
              ephemeral: true,
              payload: { bridgeId, callId, id: payload.id, t0: payload.t0, t1: Date.now() },
            });
            break;
          case "voicelab/call-accepted":
            // Another bridge has taken this call over; stand down quietly.
            if (payload.callId === callId && payload.bridgeId !== bridgeId) {
              teardown("superseded by a newer bridge", true);
            }
            break;
          case "voicelab/call-ended":
            if (payload.callId === callId) teardown("call-ended event");
            break;
          default:
            break;
        }
      }
      if (currentBatches >= 600 && !opening && !closedDown) void reopen();
    };

    const reopen = async () => {
      if (opening || closedDown) return;
      opening = true;
      const previous = currentConnection;
      try {
        generation++;
        if (generation > 1) reconnects++;
        const next = await stream.openConnection({
          connectionKey: `voicelab-worker-bridge-${callId}-g${generation}`,
          eventTypes: [
            "voicelab/mic-frame",
            "voicelab/ping",
            "voicelab/turn",
            "voicelab/say",
            "voicelab/call-ended",
            "voicelab/call-accepted",
          ],
          processEventBatch: (batch) => handleEvents(batch.events),
          ...(lastSeenOffset >= 0 ? { replayAfterOffset: lastSeenOffset } : {}),
        });
        currentConnection = next;
        currentBatches = 0;
        previous?.close();
      } finally {
        opening = false;
      }
    };

    const startedAt = Date.now();
    let resolveFinished: () => void = () => {};
    // The detached call's whole lifetime hangs off this promise: while it is
    // pending, ctx.waitUntil keeps the invocation (and with it the Grok
    // socket and the live openConnection callback lane) alive.
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const watchdog = setInterval(() => {
      if (closedDown) return;
      const now = Date.now();
      if (now - startedAt > MAX_CALL_MS) return teardown("max call duration");
      /*
       * A CALL THAT NEVER CAME UP MUST FAIL FAST.
       *
       * `startCall` resolves on session.updated, so a provider that never
       * finishes the handshake left the caller blocked until IDLE_TIMEOUT —
       * ten minutes — while the redial ladder made 35 attempts underneath.
       * Measured: startCall still had not answered after 75 seconds. A device
       * whose call button does nothing for ten minutes is broken; a device
       * told in fifteen seconds that the provider would not answer can say
       * so and offer to try again.
       */
      if (!everReady && now - startedAt > HANDSHAKE_TIMEOUT_MS) {
        return teardown(`the provider never completed a session handshake (${redials} dials)`);
      }
      if (detached && now - lastActivityAt > IDLE_TIMEOUT_MS) return teardown("idle");
      if (opening) return;
      /*
       * Recycle on SILENCE FROM A PEER WE KNOW IS TALKING, never on stream
       * silence. This used to fire whenever no batch had arrived for 5s —
       * which is the normal state of an idle call, so the bridge reopened
       * its connection every 5 seconds for as long as it lived, each cycle
       * appending the platform's connection-opened/closed pair to the
       * stream. That is a stream being written to on a timer, which is
       * exactly what makes a Durable Object slow forever.
       *
       * A device pings every 5s, so once one has ever pinged, three missed
       * pings means the delivery lane is dead and worth replacing. A peer
       * that never pings (a script, a test) is never second-guessed.
       */
      if (pingsSeen > 0 && now - heardFromPeerAt > 16_000) {
        /*
         * Three lanes is enough to tell a broken connection from an absent
         * peer: a device that is still there answers on the first or second,
         * and one that has gone answers on none of them. Tearing down frees
         * the stream for the next call, which is the difference between a
         * lab you can use twice and one that needs a new stream every run.
         */
        if (recyclesWithoutPeer >= 3) {
          return teardown(
            `the peer stopped answering across ${recyclesWithoutPeer} delivery lanes`,
          );
        }
        recyclesWithoutPeer++;
        void reopen();
      }
    }, 500);

    const teardown = (reason: string, superseded = false) => {
      if (closedDown) return;
      closedDown = true;
      clearInterval(watchdog);
      /*
       * A superseded call must NOT announce call-ended: the successor is
       * taking over the same callId, and the device would read its
       * predecessor's obituary as "your call ended" and stop sending audio.
       */
      if (!superseded) {
        fireAppend({
          type: "voicelab/call-ended",
          payload: {
            bridgeId,
            callId,
            reason: `worker bridge: ${reason} (appendErrors=${appendErrors}, reconnects=${reconnects}, redials=${redials}, providerJunk=${providerJunk}, handlerErrors=${handlerErrors}, sendFailures=${sendFailures}, droppedSpk=${droppedSpk}, stray=${strayEvents})`,
          },
        });
      }
      currentConnection?.close();
      try {
        upstream.close();
      } catch {}
      try {
        server?.close();
      } catch {}
      if (this.#endActiveCall === teardown) {
        this.#endActiveCall = null;
        this.#activeCallId = null;
      }
      markReady({ ok: false, reason });
      resolveFinished();
    };
    this.#endActiveCall = teardown;
    // Paired with the teardown, so a re-request of THIS call is recognised as
    // the same one for exactly as long as the call is alive.
    this.#activeCallId = callId;
    /* Grok's close is handled by attachGrok: it redials rather than ending. */
    server?.addEventListener("close", () => teardown("anchor socket closed"));
    server?.addEventListener("message", () => {
      /* anchor keepalive pings — content ignored */
    });

    await reopen();
    // `pair` is non-null exactly when this call has an anchor socket to hand back.
    if (pair !== null) return new Response(null, { status: 101, webSocket: pair[0] });

    this.ctx.waitUntil(finished);
    const ready = await sessionReady;
    return Response.json({ callId, ...ready });
  }
}

/**
 * G.711 mu-law to little-endian PCM16. The inverse of what the device does to
 * fit its microphone through a link that could not carry PCM16.
 */
function mulawToPcm16(mulaw: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(mulaw);
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const value = ~input[index]!;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    output[index] = sign !== 0 ? -sample : sample;
  }
  return output.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * A short stable fingerprint of a payload, for deriving idempotency keys FROM
 * WHAT IS BEING APPENDED rather than from a number somebody has to remember to
 * bump.
 *
 * An append whose key matches an existing event but whose payload does not
 * THROWS, naming an offset rather than a cause. So a hand-versioned key turns
 * every future edit to a payload into a setup that fails for every stream
 * already configured — and for the project-global back-office brief, one
 * unbumped edit would brick setup for every stream in the project at once.
 * Content-derived, an unchanged payload keeps its key and deduplicates, and a
 * changed one gets a new key and commits.
 *
 * FNV-1a over the serialised payload. Deterministic and dependency-free is the
 * whole requirement: this is not a security boundary, it is a way of noticing
 * that two payloads differ.
 */
function contentHash(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export const voiceBridgeRef = {
  className: "VoiceBridge",
  durableWorkerKey: "voicelab-bridge",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

function voiceAgentProcessorRef(streamPath: string) {
  return {
    className: "VoiceAgentProcessorHost",
    durableWorkerKey: "voice-agent-processor",
    path: streamPath,
    source: {
      createWorker: {
        entryPoint: "voice-agent.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
}

/** What a caller may ask for when it opens a call. */
export interface StartCallOptions {
  /** Stream the call rides on, e.g. "/voicelab/waveshare". */
  path: string;
  /** Caller-chosen id; the same id ends the call via a call-ended event. */
  callId?: string;
  model?: string;
  /**
   * Realtime provider endpoint. Defaults to xAI's. A test points this at a
   * provider it can make misbehave; the xAI key is only ever sent to x.ai.
   */
  grokBaseUrl?: string;
  voice?: string;
  effort?: "none" | "high";
  instructions?: string;
  /** Optional line the assistant speaks first, so the caller hears liveness. */
  greet?: string;
  /**
   * "manual": no VAD; the caller marks turns with voicelab/turn events. This
   * is what a push-to-talk device wants. Anything else keeps server VAD.
   */
  turns?: "manual" | "vad";
  /**
   * Give the voice a genius colleague: a text agent at /agents/colleague
   * that overhears the whole conversation as non-triggering context and is
   * asked, through one tool, whenever something has to be right. Off by
   * default — a plain voice call should not create an agent.
   */
  colleague?: boolean;
}

export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Install the subscription under a fresh key.
   *
   * A MANUAL OVERRIDE, no longer a requirement: setup appends its subscription
   * under a key derived from the stream path and the payload's own content, so
   * re-running it is a no-op — which is the point, but it also means a
   * subscription somebody removed would stay removed, the re-install being
   * deduplicated against the original. Setup now checks whether the
   * subscription is really active afterwards and heals it under a fresh key if
   * it is not, so a plain re-run after `removeVoiceAgent` works. This says "do
   * it again anyway" without asking.
   */
  reinstall?: boolean;
}

export interface SetupVoiceAgentResult {
  streamPath: string;
  created: string[];
  alreadyThere: string[];
}

const SubscriptionLifecyclePayload = z.object({ subscriptionKey: z.string() });

async function voiceAgentSubscriptionStatus(stream: Stream): Promise<{
  active: boolean;
  installation: number;
}> {
  let active = false;
  let installation = 0;
  using pager = stream.readEvents({
    eventTypes: [
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
    ],
  });
  for (;;) {
    const events = await pager.next();
    if (events.length === 0) break;
    for (const event of events) {
      const payload = SubscriptionLifecyclePayload.safeParse(event.payload);
      if (!payload.success || payload.data.subscriptionKey !== VOICE_AGENT_SUBSCRIPTION_KEY) {
        continue;
      }
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        installation++;
        active = true;
      }
      if (event.type === "events.iterate.com/stream/subscription-removed") active = false;
    }
  }
  return { active, installation };
}

type FetchVoiceBridge = (
  request: Request,
  ref: StatefulDynamicWorkerRef,
  options: { buildBudgetMs: number },
) => Promise<Response>;

async function startVoiceCall(
  fetchBridge: FetchVoiceBridge,
  options: StartCallOptions,
): Promise<Record<string, unknown>> {
  const path = options.path;
  if (!path.startsWith("/")) return { ok: false, reason: "path must be an absolute stream path" };
  const callId = options.callId ?? crypto.randomUUID().slice(0, 8);
  const params = new URLSearchParams({ callId, mode: "detached", path });
  if (options.model) params.set("model", options.model);
  if (options.grokBaseUrl) params.set("grokBaseUrl", options.grokBaseUrl);
  if (options.voice) params.set("voice", options.voice);
  if (options.effort) params.set("effort", options.effort);
  if (options.instructions) params.set("instructions", options.instructions);
  if (options.greet) params.set("greet", options.greet);
  if (options.turns === "manual") params.set("turns", "manual");
  if (options.colleague) params.set("colleague", "1");

  const startedAt = Date.now();
  const response = await fetchBridge(
    new Request(`https://voicelab.invalid/start?${params.toString()}`),
    { ...voiceBridgeRef, path },
    { buildBudgetMs: 30_000 },
  );
  if (!response.ok) {
    return {
      callId,
      ok: false,
      reason: `bridge ${response.status}: ${(await response.text()).slice(0, 200)}`,
    };
  }
  const result = (await response.json()) as Record<string, unknown>;
  return { ...result, callId, startMs: Date.now() - startedAt };
}

export class VoiceAgentProcessor extends StreamProcessor<
  VoiceAgentProcessorContract,
  {
    now(): number;
    startCall(options: StartCallOptions): Promise<Record<string, unknown>>;
  }
> {
  readonly contract = VoiceAgentProcessorContract;

  /**
   * Attempts THIS isolate is already making, as `<callId>@<requestedAtMs>`.
   *
   * The at-head pass below runs on every frame and a bridge start takes
   * seconds, so without this each frame arriving mid-build would start another
   * bridge for the same request. Keyed by the REQUEST rather than the call, so
   * a peer that asks again under the same callId is dialled again rather than
   * silently ignored by an isolate that remembers the name.
   *
   * A finished attempt is never forgotten on success: `call-accepted` is
   * appended by the bridge and takes a moment to come back round, and
   * forgetting the attempt inside that window is exactly how a second bridge
   * gets started for a call that is already live. Only a total failure — no
   * call AND no obituary — drops the entry, so the next pass can try again.
   * In memory on purpose: losing the set to an eviction is precisely what
   * makes the revived incarnation pick the obligation back up.
   */
  readonly #starting = new Set<string>();

  protected override processEvent({
    append,
    blockProcessorWhile,
    delivery,
    event,
    runInBackground,
    state,
  }: ProcessEventArgs<VoiceAgentProcessorContract>): undefined {
    if (state.birthCertificate === null) return;

    if (event?.type === "voicelab/call-requested") {
      const requestedAtMs = Date.parse(event.createdAt);
      /*
       * A fresh request is dialled the moment it is seen. A stale one falls
       * through to the at-head pass instead of being answered here, so replay
       * writes ONE obituary for the request nothing answered rather than one
       * per request this stream has ever carried.
       */
      if (this.#fresh(requestedAtMs)) {
        this.#startCall({ append, runInBackground }, event.payload, requestedAtMs);
        return;
      }
    }

    /*
     * THE AT-HEAD PASS — what replaced holding the cursor.
     *
     * Starting a bridge is a cold dynamic-worker build (30s budget) plus up
     * to HANDSHAKE_TIMEOUT_MS of provider handshake, and under
     * `blockProcessorWhile` all of that head-of-line-blocked every later
     * event on this stream — including the call-ended that would have
     * cancelled it. So the start is kicked off droppably and the OUTCOME is
     * recovered here: `pendingCall` is the fold's record of a request nothing
     * has answered, and this pass takes it on again when an eviction lost the
     * attempt that owed it.
     */
    if (!delivery.caughtUp) return;
    const pending = state.pendingCall;
    if (pending === null) return;
    if (this.#fresh(pending.requestedAtMs)) {
      this.#startCall({ append, runInBackground }, pending.request, pending.requestedAtMs);
      return;
    }
    /* Not while this isolate is still building it: that attempt answers with
     * a call-accepted or a call-failed of its own. */
    if (this.#starting.has(attemptKey(pending.callId, pending.requestedAtMs))) return;
    /*
     * BLOCKING, and only because this is one short append that closes an
     * obligation: the next event must not pass a request whose only remaining
     * outcome is an obituary, or a dropped attempt leaves the requester
     * waiting on a call that will never be built.
     */
    blockProcessorWhile(async () => {
      await this.#recordFailure(
        append,
        pending.callId,
        pending.requestedAtMs,
        `no bridge started within ${CALL_REQUEST_FRESHNESS_MS}ms of the request`,
      );
    });
  }

  protected override reduce({ event, state }: ReduceArgs<VoiceAgentProcessorContract>) {
    if (event.type === "events.iterate.com/voice-agent/created") {
      return { ...state, birthCertificate: {} };
    }
    if (event.type === "voicelab/call-requested") {
      const requestedAtMs = Date.parse(event.createdAt);
      return {
        ...state,
        pendingCall: {
          callId: event.payload.callId,
          requestedAtMs: Number.isFinite(requestedAtMs) ? requestedAtMs : 0,
          request: event.payload,
        },
      };
    }
    /* The two answers. Either one closes the obligation it names. */
    if (event.type === "voicelab/call-accepted" || event.type === "voicelab/call-failed") {
      if (state.pendingCall?.callId !== event.payload.callId) return state;
      return { ...state, pendingCall: null };
    }
    return state;
  }

  /** Is this request still worth dialling, or has the moment passed? */
  #fresh(requestedAtMs: number): boolean {
    return (
      Number.isFinite(requestedAtMs) && this.deps.now() - requestedAtMs <= CALL_REQUEST_FRESHNESS_MS
    );
  }

  #startCall(
    lane: Pick<ProcessEventArgs<VoiceAgentProcessorContract>, "append" | "runInBackground">,
    request: ProcessorRequest,
    requestedAtMs: number,
  ): void {
    const callId = request.callId;
    const attempt = attemptKey(callId, requestedAtMs);
    if (this.#starting.has(attempt)) return;
    this.#starting.add(attempt);
    lane.runInBackground(async () => {
      let reason: string;
      try {
        const result = await this.deps.startCall({ path: this.path, ...request });
        /* The BRIDGE appends call-accepted when the provider accepts the
         * session; that is what closes this obligation on success. */
        if (result.ok === true) return;
        reason =
          typeof result.reason === "string"
            ? result.reason
            : `voice bridge rejected call request: ${JSON.stringify(result)}`;
      } catch (error) {
        reason = String(error);
      }
      try {
        await this.#recordFailure(lane.append, callId, requestedAtMs, reason);
      } catch (error) {
        /*
         * Neither the call nor its obituary landed, so nothing closed the
         * obligation. Forget the ATTEMPT — never the obligation, which is the
         * fold's — so the next at-head pass takes it on again.
         */
        this.#starting.delete(attempt);
        throw error;
      }
    });
  }

  /**
   * Say out loud that this call is not happening.
   *
   * A failed start used to append nothing at all, and past the freshness
   * window the handler returned early forever — so a device that appended
   * `voicelab/call-requested` and never saw `voicelab/call-accepted` had no
   * way to tell "still building" from "never going to happen".
   */
  async #recordFailure(
    append: ProcessEventArgs<VoiceAgentProcessorContract>["append"],
    callId: string,
    requestedAtMs: number,
    reason: string,
  ): Promise<void> {
    await append({
      type: "voicelab/call-failed",
      /* State-derived, so the deciding state is folded into the key and NO
       * event is bound: a redelivery or a revival must not rotate this into a
       * second obituary for one call. */
      idempotencyKey: this.idempotencyKey(`call-failed:${callId}:${requestedAtMs}`),
      payload: { callId, reason: reason.slice(0, 500) },
    });
  }
}

/** The call-request payload as the fold stores and replays it. */
type ProcessorRequest = z.output<typeof VoiceCallRequestedPayload>;

/** One attempt at one request — a callId reused for a second request is a
 * second attempt, not the same one already in flight. */
function attemptKey(callId: string, requestedAtMs: number): string {
  return `${callId}@${String(requestedAtMs)}`;
}

export class VoiceAgentProcessorHost extends IterateDurableObject {
  #host = createProcessorHost({
    ctx: this.ctx,
    env: this.env,
    recovery: true,
    createProcessor: (deps) =>
      new VoiceAgentProcessor({
        ...deps,
        now: () => Date.now(),
        startCall: async (options) =>
          await startVoiceCall(
            async (request, ref, fetchOptions) =>
              await this.fetchDynamicWorker(request, ref, fetchOptions),
            options,
          ),
      }),
  });

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#host.handleAlarm(alarmInfo);
  }

  get processor() {
    return this.#host.wakeProcessor;
  }
}

export default class VoiceAgentEntrypoint extends IterateWorkerEntrypoint {
  /**
   * Prove this guest is BUILT, RUNNING, and able to reach its own project.
   *
   * A dynamic worker is built lazily on the first call into it, so that first
   * call carries a cold build — and if the build fails, it fails there, in
   * whatever the caller happened to be doing. Committing the file says
   * nothing about whether it compiles.
   *
   * Having a call whose only job is to be the first one means a caller can
   * wait for the worker deliberately, retry a cold start without retrying
   * anything that has side effects, and report a build failure as a build
   * failure rather than as "the conversation would not start".
   *
   * It touches `this.itx` on purpose: a worker that loads but cannot reach
   * its project is not healthy, and answering from a field would prove only
   * that the isolate booted.
   */
  async health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }> {
    const project = await this.itx;
    const projectId = await project.projectId;
    const secret = await project.secrets.get(XAI_SECRET).__describe();
    /*
     * Reported rather than thrown. Whether a credential exists is the
     * caller's decision to act on, and a health check that fails on policy
     * cannot distinguish "this worker is broken" from "you have not finished
     * setting up" — which are different problems with different fixes.
     */
    return {
      ok: true,
      projectId,
      xaiSecretReady: secret.created === true && secret.hasMaterial === true,
    };
  }

  async setupVoiceAgent(options: SetupVoiceAgentOptions = {}): Promise<SetupVoiceAgentResult> {
    const streamPath = options.streamPath ?? `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(
        `voice-agent streamPath must be absolute; received ${JSON.stringify(streamPath)}`,
      );
    }

    const project = await this.itx;
    const xaiSecret = await project.secrets.get(XAI_SECRET).__describe();
    if (!xaiSecret.created || !xaiSecret.hasMaterial) {
      throw new Error(
        'Voice agent setup requires secret "/secrets/xai" with material. Create it explicitly with ' +
          'await itx.secrets.get("/secrets/xai").create({ egress: { urls: ["https://api.x.ai"] }, material: "<xAI API key>" }); then rerun setupVoiceAgent. The voice agent never creates or copies credentials.',
      );
    }

    /*
     * Setting up is APPENDING, and an append carrying an idempotencyKey is
     * already idempotent — the platform deduplicates on it. So nothing below
     * is read before it is written: every event is appended unconditionally
     * under a key derived from what it is, and a second run appends the same
     * keys and changes nothing.
     *
     * The earlier shape asked "does this exist?" before each append purely to
     * print a nicer report. That cost four extra round trips, raced with
     * itself (two concurrent setups would both read "absent" and both claim
     * to have created), and still could not be trusted. What is reported
     * instead is derived from what came back: a deduplicated append returns
     * the event that was already on the stream, so an event older than this
     * call is one this call did not create.
     *
     * There is ONE read, at the end, and it is a different question: not "did
     * I create this?" but "is this stream actually listening?" — see below.
     */
    const stream = project.streams.get(streamPath);
    const backOffice = project.agents.get(COLLEAGUE_PATH);
    const birthPayload = {};
    /*
     * THE SUBSCRIPTION, as one value, because its KEY is derived from it.
     *
     * `subscriptionKey` inside the payload is the platform's own handle on the
     * subscription and must stay the stable VOICE_AGENT_SUBSCRIPTION_KEY: that
     * is what makes a re-install REPLACE this subscription rather than run a
     * second one alongside it. The idempotency key underneath is a different
     * thing entirely and follows the content — see contentHash.
     */
    const subscriptionPayload = {
      subscriptionKey: VOICE_AGENT_SUBSCRIPTION_KEY,
      description: "Wake the separately deployed voice-agent guest for call requests.",
      filter: {
        eventTypes: [
          "events.iterate.com/voice-agent/created",
          "voicelab/call-requested",
          /* The processor folds the ANSWERS too — an outstanding call request
           * is a fact of its state, not a closure an eviction can take with
           * it — and hosted delivery is filtered, so an event missing from
           * this list never reaches the fold at all. */
          "voicelab/call-accepted",
          "voicelab/call-failed",
        ],
      },
      receiver: {
        action: "processor-wake",
        expression: [
          "workers",
          ["get", voiceAgentProcessorRef(streamPath)],
          "processor",
          "wakeStreamProcessor",
        ],
        processorSlug: VOICE_AGENT_PROCESSOR_SLUG,
      },
    };
    const subscriptionKeyPrefix = `voice-agent/subscription-configured:${streamPath}`;
    const subscriptionKey = options.reinstall
      ? `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`
      : `${subscriptionKeyPrefix}:${contentHash(subscriptionPayload)}`;
    const birthKey = `voice-agent/created:${streamPath}:${contentHash(birthPayload)}`;

    const startedAt = Date.now();
    const [voiceEvents, agentEvents] = await Promise.all([
      stream.append(
        {
          type: "events.iterate.com/voice-agent/created",
          idempotencyKey: birthKey,
          payload: birthPayload,
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: subscriptionKey,
          payload: subscriptionPayload,
        },
      ),
      /* Born and briefed — the same helper the call path uses, so a call that
       * never went through setup gets the same colleague. */
      ensureBackOffice(backOffice),
    ]);

    const created: string[] = [];
    const alreadyThere: string[] = [];
    for (const event of [...voiceEvents, ...agentEvents]) {
      const key = event.idempotencyKey ?? `${event.path}@${String(event.offset)}`;
      (Date.parse(event.createdAt) < startedAt ? alreadyThere : created).push(key);
    }

    /*
     * AND IS IT ACTUALLY LISTENING?
     *
     * Setup's contract is "this stream is ready to hold a conversation", so it
     * must not report success having left it deaf. The append above
     * deduplicates against the original install, which is the point — but
     * after `removeVoiceAgent` the original is REMOVED, and a deduplicated
     * re-append changes nothing while reporting that it did. Nobody discovers
     * that until a conversation fails to start.
     */
    if (!(await voiceAgentSubscriptionStatus(stream)).active) {
      const healKey = `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`;
      await stream.append({
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: healKey,
        payload: subscriptionPayload,
      });
      created.push(healKey);
    }
    return { streamPath, created, alreadyThere };
  }

  async removeVoiceAgent(options: { streamPath: string }): Promise<{
    streamPath: string;
    removed: string[];
    alreadyAbsent: string[];
    /**
     * What to call to get this stream talking again.
     *
     * Named here because setup's subscription key is derived from the stream
     * path and the payload's content, so a plain re-run after a removal
     * deduplicates against the original install. Setup heals that itself now —
     * it checks the subscription really is active and re-installs it under a
     * fresh key if not — but saying so still beats making the caller work it
     * out by watching a conversation fail to start.
     */
    reinstallWith: string;
  }> {
    if (!options.streamPath?.startsWith("/")) {
      throw new Error(
        `removeVoiceAgent requires an absolute streamPath; received ${JSON.stringify(options.streamPath)}`,
      );
    }
    const project = await this.itx;
    const stream = project.streams.get(options.streamPath);
    const subscription = await voiceAgentSubscriptionStatus(stream);

    const removed: string[] = [];
    const alreadyAbsent: string[] = [];
    if (subscription.active) {
      const removalKey = `voice-agent/subscription-removed:v1:${options.streamPath}:install:${subscription.installation}`;
      await stream.append({
        type: "events.iterate.com/stream/subscription-removed",
        idempotencyKey: removalKey,
        payload: { subscriptionKey: VOICE_AGENT_SUBSCRIPTION_KEY, reason: "requested" },
      });
      removed.push(removalKey);
    } else {
      alreadyAbsent.push(VOICE_AGENT_SUBSCRIPTION_KEY);
    }

    using processor = project.workers.get(voiceAgentProcessorRef(options.streamPath));
    await processor.kill();
    using bridge = project.workers.get({ ...voiceBridgeRef, path: options.streamPath });
    await bridge.kill();
    return {
      streamPath: options.streamPath,
      removed,
      alreadyAbsent,
      reinstallWith: `setupVoiceAgent({ streamPath: ${JSON.stringify(options.streamPath)}, reinstall: true })`,
    };
  }

  /**
   * Open a voice call that outlives this request: the bridge DO holds the
   * Grok socket and the stream subscription by itself, so the only thing a
   * device has to do is call this once over its ordinary itx session and
   * then push mic frames. Returns when Grok has accepted the session.
   * Ending it is an ordinary `voicelab/call-ended` append with the same
   * callId — no second connection, anywhere.
   */
  async startCall(options: StartCallOptions): Promise<Record<string, unknown>> {
    return await startVoiceCall(
      async (request, ref, fetchOptions) =>
        await this.fetchDynamicWorker(request, ref, fetchOptions),
      options,
    );
  }

  /** Hang up. Equivalent to appending call-ended yourself; here for callers
   * that would rather not build the event. */
  async endCall(options: { path: string; callId: string; reason?: string }): Promise<void> {
    const project = await this.env.ITX.get();
    await project.streams.get(options.path).append({
      type: "voicelab/call-ended",
      payload: { callId: options.callId, reason: options.reason ?? "hangup" },
    });
  }

  /** Spike diagnostic: dial Grok realtime through the egress lane, report timings. */
  async probeGrok(): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    const response = await fetch("https://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0", {
      headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/xai")' },
    });
    const socket = response.webSocket;
    if (socket === null) {
      return { ok: false, status: response.status, body: (await response.text()).slice(0, 300) };
    }
    socket.accept();
    const upgradeMs = Date.now() - t0;
    const seen: string[] = [];
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: "timeout", seen }), 10_000);
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        const event = JSON.parse(message.data) as { type?: string };
        seen.push(event.type ?? "?");
        if (event.type === "session.created") {
          socket.send(JSON.stringify({ type: "session.update", session: { voice: "eve" } }));
        }
        if (event.type === "session.updated") {
          clearTimeout(timer);
          resolve({ ok: true, upgradeMs, sessionReadyMs: Date.now() - t0, seen });
        }
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `closed ${event.code}`, seen });
      });
    });
    socket.close();
    return result;
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "voice") {
      // One VoiceBridge DO instance PER CALL: durable identity is
      // (projectId, path, durableWorkerKey), so keying path by the call
      // avoids reusing an instance whose previous invocation crashed or
      // still holds sockets. Bridge calls key by their stream path; proxy
      // calls get a random instance.
      const url = new URL(req.url);
      const callPath =
        url.searchParams.get("mode") === "bridge" && url.searchParams.get("path")
          ? url.searchParams.get("path")!
          : `/proxy-${crypto.randomUUID().slice(0, 8)}`;
      return this.fetchDynamicWorker(req, { ...voiceBridgeRef, path: callPath });
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });
    return new Response("voicelab project worker — voice app at voice--<host>", {
      headers: { "content-type": "text/plain" },
    });
  }
}

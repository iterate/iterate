import {
  IterateDurableObject,
  IterateWorkerEntrypoint,
  type StatefulDynamicWorkerRef,
} from "iterate/sdk";

// voicelab worker: the "server side" of the voice pipe, in userspace.
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
//                 uses — `itx.worker.startCall(...)` returns the moment the
//                 Grok session is live and nothing outside the platform has
//                 to stay running for the call to continue.
//
// The Grok key never enters this isolate: the upgrade fetch carries a
// getSecret placeholder that the platform substitutes en route to the
// pinned origin.

const XAI_SECRET = "/secrets/xai";
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
 * The agent that does the actual thinking. Grok is a mouth and a pair of
 * ears with a ~200ms budget; anything that needs reading a repo, calling a
 * tool, or being RIGHT belongs to a text model with no clock on it.
 */
const COLLEAGUE_PATH = "/agents/colleague";
/**
 * What the voice model is told it is. The important half is the second
 * paragraph: without an explicit instruction to keep talking, a voice model
 * handed an async tool goes silent waiting for it, which sounds exactly like
 * a dropped call.
 */
const VOICE_INSTRUCTIONS = [
  "You are the VOICE of a team. You are not the one who does the work: you have a",
  "genius colleague — a careful, well-read expert with access to the customer's",
  "systems — and they answer anything that needs real thought, real knowledge, or",
  "any action in the world. Your job is to listen well, be good company, and speak",
  "their answers out loud.",
  "",
  "Call ask_colleague for ANY question worth getting right, and for anything you",
  "would otherwise guess at. It returns immediately — your colleague is thinking,",
  "not answering — so do NOT go quiet waiting for them. Say you have asked and are",
  "waiting, and keep the conversation going meanwhile: ask what prompted the",
  "question, or talk about something else. Their answer arrives as a message",
  "beginning 'Your colleague says'; when it does, tell the customer in your own",
  "words, out loud, as if you had just been handed a note.",
  "",
  "Speak plainly and briefly — one or two sentences unless asked for more. Never",
  "read out URLs, code, or long lists.",
].join(" ");
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "proxy";
    const detached = mode === "detached";
    if (!detached && request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("voicelab bridge: expected a websocket upgrade", { status: 426 });
    }
    const model = url.searchParams.get("model") ?? "grok-voice-think-fast-2.0";

    if (this.#endActiveCall !== null) {
      this.#endActiveCall("superseded by a new call on this stream", true);
      this.#endActiveCall = null;
    }
    const dialGrok = async () => {
      const response = await fetch(`https://api.x.ai/v1/realtime?model=${model}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer getSecret("${XAI_SECRET}")` },
      });
      const socket = response.webSocket;
      if (socket === null) return { socket: null, status: response.status };
      socket.binaryType = "arraybuffer"; // before accept(): post-2025-03-17 default is Blob
      socket.accept();
      return { socket, status: response.status };
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
    const greeting = url.searchParams.get("greet");
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
    const outbound: Parameters<typeof stream.append> = [];
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
      const events = [];
      for (let offset = 0; offset < bytes.length; offset += 640) {
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
            pcm: bytesToBase64(bytes.subarray(offset, offset + 640)),
          },
        });
      }
      if (events.length === 0) return;
      fireAppend(...events);
    };
    /*
     * THE GENIUS COLLEAGUE.
     *
     * A text agent in this project that hears the whole conversation and is
     * asked, by the voice model, whenever something needs to be right. Two
     * lanes, and the split is the entire idea:
     *
     *   listening  every finished transcript line is appended to the agent as
     *              context with "dont-trigger-request". It accumulates the
     *              conversation without ever being asked to respond to it, so
     *              when it IS asked it already knows what was said — and no
     *              LLM request is spent on a customer who is only chatting.
     *
     *   asking     ask_colleague appends the question and lets the agent take
     *              its turn. This does NOT block the voice: the tool output
     *              goes back to Grok immediately so it can say "I've asked",
     *              and the real answer is pushed into the session whenever it
     *              arrives, as a new conversation item.
     *
     * Everything here is fire-and-forget against the call's lifetime. The
     * colleague is a bonus, and a bonus must never be able to stall a voice.
     */
    const colleague = url.searchParams.get("colleague") === "1";
    const colleagueAgent = project.agents.get(COLLEAGUE_PATH);
    let colleagueReady: Promise<boolean> | null = null;
    let askedCount = 0;
    const ensureColleague = () => {
      colleagueReady ??= (async () => {
        try {
          await colleagueAgent.create({});
        } catch {
          /* Already born: create over an existing agent is loud, not fatal. */
        }
        try {
          await colleagueAgent.append({
            payload: {
              content: [
                "You are the expert half of a two-part assistant. A voice model is",
                "talking to a customer out loud and can hear you through it; you never",
                "speak to the customer directly. Everything they say and everything the",
                "voice says arrives here as context, so you always know the conversation.",
                "",
                "Most of it needs nothing from you. When you ARE asked a question,",
                "answer it properly — use your tools, look things up, be specific — and",
                "then reply with something short enough to be SPOKEN: two or three",
                "sentences of plain language, no lists, no URLs, no code. Lead with the",
                "answer. If you genuinely cannot answer, say so in one sentence.",
                "",
                "Answer by SENDING A CHAT MESSAGE. That is the only channel that reaches",
                "the customer — work in scripts all you like, but the reply itself has to",
                "be a message, and a silent agent leaves the voice apologising for you.",
              ].join("\n"),
              key: "voicelab/colleague-brief",
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
              role: "system",
            },
            type: "events.iterate.com/agents/context-added",
          });
          return true;
        } catch (error) {
          console.log(`colleague unavailable: ${String(error)}`);
          return false;
        }
      })();
      return colleagueReady;
    };
    /** Give the colleague a line of the conversation, without waking it. */
    const overhear = (who: "customer" | "voice", text: string) => {
      if (!colleague || text.trim().length === 0) return;
      this.ctx.waitUntil(
        (async () => {
          if (!(await ensureColleague())) return;
          await colleagueAgent
            .append({
              payload: {
                content: `${who === "customer" ? "Customer" : "The voice"} said: ${text}`,
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
    /** Ask, and deliver the answer whenever it comes. */
    const askColleague = (question: string) => {
      askedCount++;
      fireAppend({
        payload: { asked: askedCount, callId, question },
        type: "voicelab/colleague-asked",
      });
      this.ctx.waitUntil(
        (async () => {
          const startedAsk = Date.now();
          let answer: string;
          try {
            if (!(await ensureColleague())) throw new Error("no colleague");
            const reply = (await colleagueAgent.ask({
              message: `The customer asked, through the voice: ${question}`,
              timeoutMs: 120_000,
            })) as { payload?: { message?: string; content?: string } };
            /*
             * `ask` resolves on agents/web-message-sent, whose payload field
             * is `message`. Reading `content` (the field on context items)
             * returned an empty string for a perfectly good answer, and the
             * voice dutifully told the customer their colleague could not
             * help.
             */
            answer = reply.payload?.message ?? reply.payload?.content ?? "";
          } catch (error) {
            answer = "";
            console.log(`colleague failed: ${String(error)}`);
          }
          if (closedDown) return;
          fireAppend({
            payload: {
              answer: answer.slice(0, 2000),
              callId,
              ms: Date.now() - startedAsk,
            },
            type: "voicelab/colleague-answered",
          });
          /*
           * Wait for a gap. A colleague who answers while the assistant is
           * mid-sentence, or while the customer is still holding the talk
           * button, would have its response.create collide with the turn in
           * flight — two answers, interleaved, which is the corruption this
           * lab has heard before from two bridges.
           */
          for (let waited = 0; (responseActive || micOpen) && waited < 60_000; waited += 250) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (closedDown) return;
          /*
           * Delivered as a plain conversation item and a fresh response,
           * NOT as the tool's output: by now the voice has long since spoken,
           * and this has to interrupt the conversation the way a colleague
           * putting their head round the door does.
           */
          try {
            upstream.send(
              JSON.stringify({
                item: {
                  content: [
                    {
                      text:
                        answer.length > 0
                          ? `Your colleague says: ${answer}`
                          : "Your colleague could not answer that one — tell the customer plainly.",
                      type: "input_text",
                    },
                  ],
                  role: "user",
                  type: "message",
                },
                type: "conversation.item.create",
              }),
            );
            upstream.send(JSON.stringify({ type: "response.create" }));
          } catch {
            /* the call ended while they were thinking */
          }
        })(),
      );
    };
    /** Function calls arrive twice on some paths; answer each exactly once. */
    const answeredToolCalls = new Set<string>();
    const handleToolCall = (id: string, name: string, argumentsJson: string) => {
      if (name !== "ask_colleague" || answeredToolCalls.has(id)) return;
      answeredToolCalls.add(id);
      let question = "";
      try {
        question = String(
          (JSON.parse(argumentsJson || "{}") as { question?: unknown }).question ?? "",
        );
      } catch {
        question = argumentsJson;
      }
      /*
       * Answer the TOOL immediately, before the colleague has thought about
       * anything. A voice model waiting on a function output is a voice model
       * saying nothing, and thirty seconds of nothing is a dropped call as
       * far as anyone listening can tell.
       */
      try {
        upstream.send(
          JSON.stringify({
            item: {
              call_id: id,
              output: JSON.stringify({
                status: "asked",
                tell_the_customer:
                  "Say you have asked your colleague and are waiting, then keep talking.",
              }),
              type: "function_call_output",
            },
            type: "conversation.item.create",
          }),
        );
        upstream.send(JSON.stringify({ type: "response.create" }));
      } catch {
        /* upstream closing */
      }
      askColleague(question);
    };

    // Resolves when Grok has accepted the session — what `startCall` waits
    // for, so a caller that gets an answer knows the call is really live.
    let markReady: (ready: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const sessionReady = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      markReady = resolve;
    });
    let lastActivityAt = Date.now();
    let responseActive = false;
    /** True between a turn's start and its commit: the customer is speaking. */
    let micOpen = false;
    /** Mic frames and expanded PCM bytes handed to the provider this turn. */
    let micFrames = 0;
    let micBytes = 0;

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
    let micExpected = 0;
    const micPending = new Map<number, ArrayBuffer | Uint8Array>();
    let micReordered = 0;
    let micLate = 0;
    let micLost = 0;

    const sendMic = (pcm: ArrayBuffer | Uint8Array) => {
      upstream.send(pcm as ArrayBuffer);
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

    const onGrokMessage = (event: MessageEvent) => {
      const tGrok = Date.now();
      lastActivityAt = tGrok;
      if (typeof event.data !== "string") {
        appendSpkPcm(new Uint8Array(event.data as ArrayBuffer), tGrok);
        return;
      }
      const grokEvent = JSON.parse(event.data) as { type: string; delta?: string };
      if (grokEvent.type === "session.created") {
        upstream.send(
          JSON.stringify({
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
              ...(colleague
                ? {
                    tool_choice: "auto",
                    tools: [
                      {
                        description:
                          "Ask your genius colleague — a careful expert with access to the " +
                          "customer's systems — anything that needs real thought, knowledge, " +
                          "or action. Returns immediately: they are thinking, not answering. " +
                          "Keep talking to the customer while you wait; their answer will " +
                          "arrive as a message beginning 'Your colleague says'.",
                        name: "ask_colleague",
                        parameters: {
                          properties: {
                            question: {
                              description:
                                "The question, in full. Your colleague can hear the " +
                                "conversation, but write it so it stands on its own.",
                              type: "string",
                            },
                          },
                          required: ["question"],
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
          }),
        );
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
          upstream.send(
            JSON.stringify({
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
            }),
          );
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
      if (colleague) {
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
        fireAppend({
          type: "voicelab/grok-event" as const,
          ephemeral: true as const,
          payload: { callId, answer: answerSeq, t: Date.now(), event: grokEvent },
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
    const attachGrok = (socket: WebSocket, generation: number) => {
      socket.addEventListener("message", onGrokMessage);
      socket.addEventListener("close", (event) => {
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
      const next = await dialGrok().catch(() => ({ socket: null, status: 0 }));
      if (next.socket === null) {
        console.log(`redial failed (${next.status}); retrying`);
        return void redialGrok(`redial failed ${next.status}`);
      }
      grokGeneration++;
      upstream = next.socket;
      attachGrok(next.socket, grokGeneration);
    };

    attachGrok(upstream, grokGeneration);

    // Live subscription for mic frames + control. Session connections die
    // silently (push budget ~1000, DO resets), so recycle make-before-break
    // on a batch budget and on delivery silence while the call is active.
    let generation = 0;
    let currentConnection: { close(): void } | null = null;
    let currentBatches = 0;
    let lastBatchAt = Date.now();
    /*
     * When a PEER last spoke to us — a mic frame, a turn edge, a ping. Not
     * the same thing as "a batch arrived": the platform's own connection
     * bookkeeping is not delivered here, and an idle call legitimately
     * carries no traffic at all for minutes.
     */
    let heardFromPeerAt = Date.now();
    /** A peer that pings is one whose silence means something. */
    let pingsSeen = 0;
    let lastSeenOffset = -1;
    let reconnects = 0;
    let opening = false;
    let closedDown = false;

    const handleEvents = (events: { type: string; offset: number; payload?: unknown }[]) => {
      lastBatchAt = Date.now();
      currentBatches++;
      for (const event of events) {
        if (event.offset <= lastSeenOffset) continue;
        lastSeenOffset = event.offset;
        // Everything delivered here was appended by a peer, by definition:
        // the subscription only names voicelab/* types.
        heardFromPeerAt = Date.now();
        const payload = (event.payload ?? {}) as Record<string, unknown>;
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
              upstream.send(JSON.stringify({ type: "response.cancel" }));
              responseActive = false;
            }
            upstream.send(
              JSON.stringify({
                item: {
                  content: [{ text, type: "input_text" }],
                  role: "user",
                  type: "message",
                },
                type: "conversation.item.create",
              }),
            );
            upstream.send(JSON.stringify({ type: "response.create" }));
            break;
          }
          case "voicelab/turn": {
            lastActivityAt = Date.now();
            if (payload.action === "start") {
              micOpen = true;
              micFrames = 0;
              micBytes = 0;
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
                upstream.send(JSON.stringify({ type: "response.cancel" }));
                responseActive = false;
              }
            } else if (payload.action === "commit") {
              micOpen = false;
              /* Nothing more is coming to fill the gaps, so send what waited
               * BEFORE asking the provider to answer — a frame handed over
               * after the commit is speech the answer never heard. */
              flushMic();
              upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              upstream.send(JSON.stringify({ type: "response.create" }));
              /*
               * What the provider was actually given for this turn. A device
               * that speaks and hears nothing back is either not reaching
               * here (frames 0) or being answered badly (frames fine) — and
               * without this number those two look the same from the outside.
               */
              fireAppend({
                type: "voicelab/turn-committed",
                ephemeral: true,
                payload: {
                  bridgeId,
                  callId,
                  frames: micFrames,
                  bytes: micBytes,
                  ms: Math.round(micBytes / 32),
                  /* Out-of-order arrivals are expected and harmless; LOST
                   * frames are the number that matters, and a rising `late`
                   * means the device is re-sending what we already used. */
                  reordered: micReordered,
                  late: micLate,
                  lost: micLost,
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
        lastBatchAt = Date.now();
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
      if (pingsSeen > 0 && now - heardFromPeerAt > 16_000) void reopen();
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
            reason: `worker bridge: ${reason} (appendErrors=${appendErrors}, reconnects=${reconnects})`,
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
      if (this.#endActiveCall === teardown) this.#endActiveCall = null;
      markReady({ ok: false, reason });
      resolveFinished();
    };
    this.#endActiveCall = teardown;
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
    createWorker: { entryPoint: "worker.ts", files: { repoPath: "/repos/config", type: "repo" } },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

/** What a caller may ask for when it opens a call. */
export interface StartCallOptions {
  /** Stream the call rides on, e.g. "/voicelab/waveshare". */
  path: string;
  /** Caller-chosen id; the same id ends the call via a call-ended event. */
  callId?: string;
  model?: string;
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

export default class ProjectWorker extends IterateWorkerEntrypoint {
  /**
   * Open a voice call that outlives this request: the bridge DO holds the
   * Grok socket and the stream subscription by itself, so the only thing a
   * device has to do is call this once over its ordinary itx session and
   * then push mic frames. Returns when Grok has accepted the session.
   * Ending it is an ordinary `voicelab/call-ended` append with the same
   * callId — no second connection, anywhere.
   */
  async startCall(options: StartCallOptions): Promise<Record<string, unknown>> {
    const path = options.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      return { ok: false, reason: "path must be an absolute stream path" };
    }
    const callId = options.callId ?? crypto.randomUUID().slice(0, 8);
    const params = new URLSearchParams({ callId, mode: "detached", path });
    if (options.model) params.set("model", options.model);
    if (options.voice) params.set("voice", options.voice);
    if (options.effort) params.set("effort", options.effort);
    if (options.instructions) params.set("instructions", options.instructions);
    if (options.greet) params.set("greet", options.greet);
    if (options.turns === "manual") params.set("turns", "manual");
    if (options.colleague) params.set("colleague", "1");

    const startedAt = Date.now();
    const response = await this.fetchDynamicWorker(
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

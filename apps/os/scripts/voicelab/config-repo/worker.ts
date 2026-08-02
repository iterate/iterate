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
    const upstreamResponse = await fetch(`https://api.x.ai/v1/realtime?model=${model}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer getSecret("${XAI_SECRET}")` },
    });
    const upstream = upstreamResponse.webSocket;
    if (upstream === null) {
      return new Response(`xai upgrade failed: ${upstreamResponse.status}`, { status: 502 });
    }
    upstream.binaryType = "arraybuffer"; // before accept(): post-2025-03-17 compat default is Blob
    upstream.accept();

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
     * ?pace=1: drip speaker events instead of relaying Grok's burst instantly.
     * A constrained consumer takes each delivery into a bounded inbox and
     * cannot absorb hundreds of messages in one TCP clump.
     *
     * The rate must be realtime, and it must not DRIFT. Anything faster than
     * the device plays accumulates for the whole answer: at 2x a 60s answer
     * left 30s queued, which overran the device buffer and shredded the
     * waveform; even a 5% lead accumulated 3s and overflowed a 1s buffer.
     *
     * So the schedule is absolute, not an interval: frame N is due at
     * start + N*20ms. A late tick catches up instead of compounding, and the
     * device's buffer holds jitter rather than a growing backlog.
     *
     * But exactly-realtime with no head start gives the device NO cushion:
     * its buffer hovers at the prefill mark and any jitter empties it, which
     * costs a re-prime. Measured that way: 45 underruns in 3099 frames, each
     * inserting 160 ms of silence — about 7 s of stutter per minute, which is
     * precisely the "choppy audio" being reported.
     *
     * So the first BURST_MS of a response goes out as fast as the wire takes
     * it, and the realtime schedule starts after it. It is sized against the
     * device's internal-RAM ring (900 ms) with room for jitter on top —
     * bursting more than the consumer can hold just drops frames on arrival. That buys a standing
     * cushion of that size, once per response, which absorbs jitter without
     * accumulating over the answer the way a rate multiplier does.
     */
    /*
     * 250ms, not 450 — because this lead is NOT the whole cushion.
     *
     * The device buys its own before it starts playing: it waits for ~390ms
     * of prefill so the first frame does not play with an empty ring. That
     * prefill and this lead STACK, and measured against the device's 900ms
     * internal ring the steady-state margin sat at 811-898ms — a ring
     * essentially full, with tens of milliseconds of headroom for jitter.
     *
     * A 5-minute soak overflowed it 64 times in one answer: a second and a
     * quarter of speech thrown away on arrival, and then five underruns as
     * the hole came round. This is what "very choppy" has been.
     *
     * 250 + 390 is ~640ms of cushion in a 900ms ring: still far more than the
     * worst RTT ever measured here, with a quarter of a second spare.
     */
    const BURST_MS = 250;
    /** Barge-in discards pending audio; everything else keeps its place. */
    const dropQueuedAudio = () => {
      for (let index = paceQueue.length - 1; index >= 0; index--) {
        if (paceQueue[index]?.type === "voicelab/spk-frame") {
          paceQueue.splice(index, 1);
        }
      }
      paceStartedAt = 0;
      pacedFrames = 0;
    };
    const pacing = url.searchParams.get("pace") === "1";
    const paceQueue: Parameters<typeof stream.append>[0][] = [];
    let paceTimer: ReturnType<typeof setTimeout> | null = null;
    let paceStartedAt = 0;
    let pacedFrames = 0;
    const pacePump = () => {
      if (paceTimer !== null) return;
      if (paceQueue.length === 0) return;
      if (paceStartedAt === 0) {
        // First frames of a RESPONSE go immediately: that is the device's
        // prefill, and delaying it is pure added latency. Anchored once per
        // response, not once per drain — see tick().
        paceStartedAt = Date.now();
        pacedFrames = 0;
      }
      const tick = () => {
        paceTimer = null;
        const slice = paceQueue.splice(0, 5);
        if (slice.length === 0) {
          /*
           * Queue momentarily dry — Grok generates in chunks, so this happens
           * repeatedly WITHIN one answer. The schedule must NOT reset here:
           * doing so handed every chunk a fresh opening burst, so a long
           * answer was delivered far faster than realtime and overran the
           * device's buffer (measured: 127 dropped frames in one answer,
           * heard as choppiness). The anchor belongs to the response, and is
           * cleared by response.created / response.done.
           */
          return;
        }
        fireAppend(...slice);
        pacedFrames += slice.length;
        // Absolute deadline, with the opening burst delivered immediately:
        // frame N is due at start + max(0, N - burstFrames) * 20ms.
        const burstFrames = BURST_MS / 20;
        const due = paceStartedAt + Math.max(0, pacedFrames - burstFrames) * 20;
        paceTimer = setTimeout(tick, Math.max(0, due - Date.now()));
      };
      tick();
    };

    const appendSpkPcm = (bytes: Uint8Array, tGrok: number) => {
      // Re-chunk to 20ms events (640B PCM) so constrained consumers with
      // per-batch delivery caps can take them; one atomic append per Grok
      // frame keeps commits low.
      const events = [];
      for (let offset = 0; offset < bytes.length; offset += 640) {
        events.push({
          type: "voicelab/spk-frame",
          ephemeral: true as const,
          payload: {
            callId,
            seq: spkSeq++,
            t: Date.now(),
            tGrok,
            pcm: bytesToBase64(bytes.subarray(offset, offset + 640)),
          },
        });
      }
      if (events.length === 0) return;
      if (!pacing) return fireAppend(...events);
      paceQueue.push(...events);
      pacePump();
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

    upstream.addEventListener("message", (event) => {
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
        fireAppend({
          type: "voicelab/call-accepted",
          payload: {
            bridge: detached ? "worker-detached" : "worker",
            bridgeId,
            callId,
            model,
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
        // New response: a fresh burst allowance and a fresh realtime anchor.
        paceStartedAt = 0;
        pacedFrames = 0;
      }
      if (grokEvent.type === "response.done") responseActive = false;
      if (grokEvent.type === "input_audio_buffer.speech_started") {
        // Barge-in: everything still queued is answer the user talked over.
        paceQueue.length = 0;
      }
      if (FORWARDED_GROK_EVENTS.has(grokEvent.type)) {
        const event = {
          type: "voicelab/grok-event" as const,
          ephemeral: true as const,
          payload: { callId, t: Date.now(), event: grokEvent },
        };
        /*
         * Transcript and response-lifecycle events ride the SAME paced queue
         * as the audio they describe, so they keep their position relative
         * to it. Sending them immediately let response.done overtake the
         * answer still queued behind it — the device then showed "ready,
         * hold to talk" while it was still speaking, and the transcript ran
         * ahead of the voice.
         *
         * Barge-in is the deliberate exception: speech_started must reach
         * the device as fast as the wire allows, because its whole job is to
         * stop playback. Pacing it would defeat it.
         */
        if (pacing && grokEvent.type !== "input_audio_buffer.speech_started") {
          paceQueue.push(event);
          pacePump();
        } else {
          fireAppend(event);
        }
      }
    });

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
            try {
              upstream.send(base64ToBytes(payload.pcm as string));
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
            dropQueuedAudio();
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
              // Everything queued is answer the user just talked over.
              dropQueuedAudio();
              if (responseActive) {
                upstream.send(JSON.stringify({ type: "response.cancel" }));
                responseActive = false;
              }
            } else if (payload.action === "commit") {
              micOpen = false;
              upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              upstream.send(JSON.stringify({ type: "response.create" }));
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
      if (paceTimer !== null) clearTimeout(paceTimer);
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
    upstream.addEventListener("close", (event) => teardown(`grok closed ${event.code}`));
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
  /** Drip speaker frames at ~2x realtime — set this from a microcontroller. */
  pace?: boolean;
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
    if (options.pace) params.set("pace", "1");
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

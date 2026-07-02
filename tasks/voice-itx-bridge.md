---
status: in-progress
size: medium
branch: mmkal/26/07/02/voice-itx-bridge
---

# Voice ↔ itx bridge: `ask_assistant` multiplexer prototype

## Status summary

Working end-to-end in text mode against local dev with OpenAI Realtime: user
turns forward to a real itx codemode agent, worker reports inject back, the
voice agent relays results. Tool-only mode demonstrated the motivating
failure (voice model says "let me get that going" and never calls the tool).
Remaining: real-mic audio mode is written but untested (needs a human), and
Grok itself is untested (needs `XAI_API_KEY`).

## The ask (as given)

Try out a new kind of voice agent — probably Grok voice, but any of the
realtime voice APIs would do. They all have awful tool calling, so instead of
trusting the voice model to invoke tools, "multiplex" the conversation: every
time the human ends a turn, forward the conversation to an iterate "assistant"
(an itx agent) as if the human had asked it directly ("can you list files in
xyz" etc.). The voice agent's system prompt tells it that it has a parallel
"worker" agent, so it acks naturally ("I'll get right on that"). When the
worker (which produces codemode snippets and actually does stuff) replies,
inject the result back into the voice conversation so the voice agent can say
"ok, got some results for you".

## Decisions (my best guesses, delineated)

_These are assumptions made while fleshing out an underspecified task._

1. **Provider: Grok first, OpenAI as fallback.** Grok's Voice Agent API
   (`wss://api.x.ai/v1/realtime?model=grok-voice-latest`) is OpenAI
   Realtime-compatible, so one client speaks both dialects. Doppler currently
   has `OPENAI_API_KEY` but no `XAI_API_KEY`; the bridge picks Grok when
   `XAI_API_KEY` is set, else OpenAI (`wss://api.openai.com/v1/realtime`).
   Explicit `--provider grok|openai` override.
2. **Where it lives:** `apps/os/scripts/voice/` + a `voice` namespace on the
   OS CLI (`pnpm cli voice chat`), following the doppler-backed scripts
   pattern. It's a client-side prototype — no worker/deploy changes.
3. **Forwarding is client-orchestrated, not model-initiated.** The bridge
   listens for the user-turn-transcription-completed realtime event and always
   forwards the transcript to the itx agent via `agent.sendMessage()`. An
   `ask_assistant` function tool is _also_ registered so that if the voice
   model does call it, the call completes cleanly (deduped against the
   automatic forward — the tool call gets a `function_call_output` ack
   immediately; the real answer arrives later like any other worker reply).
   `--forward tool` disables the automatic lane to compare how bad
   tool-calling really is.
4. **Reply injection:** worker replies arrive by watching the agent's stream
   for `events.iterate.com/agents/web-message-sent` after the forwarded
   message's offset. Each reply is injected as a user-role
   `conversation.item.create` wrapped in a `[worker report] …` envelope,
   followed by `response.create`, so the voice agent verbally relays results.
   (Grok also has a `force_message` item type for verbatim TTS — noted as an
   option, but paraphrase-by-the-voice-model is the point of the demo.)
5. **The "assistant" is a plain itx agent** at `/agents/voice-assistant` in a
   project you point the bridge at (`--project <id>`, or `--create-project`
   for a throwaway). No new server-side anything: `sendMessage` → codemode
   snippet → `itx.chat.sendMessage` reply, exactly like web chat.
6. **Audio I/O via ffmpeg** (installed): `ffmpeg -f avfoundation` mic capture
   → PCM16 24kHz mono → base64 `input_audio_buffer.append`; output deltas →
   `ffplay` (headless pipe). Server VAD handles turn taking.
7. **`--text` mode is first-class**: a stdin REPL that sends `input_text`
   items instead of audio and prints text/transcript deltas. This is how the
   bridge gets tested autonomously (no mic in CI/agent-land), and it
   exercises the identical multiplexing path.

## Checklist

- [x] task file fleshed out and committed first _(commit b303ab08b)_
- [x] realtime client (thin ws wrapper, Grok/OpenAI dialects, session.update
      with instructions + `ask_assistant` tool + server VAD)
      _(`apps/os/scripts/voice/realtime.ts`)_
- [x] itx assistant lane (connect, sendMessage on turn end, stream-watch for
      web-message-sent replies, inject + response.create)
      _(`bridge.ts` — `forwardTurn`/`askWorker`; client-side 120s wait instead
      of `agent.ask`'s server-side 45s cap)_
- [x] `ask_assistant` tool completion path (`function_call_output` ack +
      dedupe) _(acked immediately with "forwarded to worker"; in auto mode the
      call is not re-forwarded)_
- [x] `--text` REPL mode _(readline over stdin; the whole e2e test path)_
- [x] audio mode (ffmpeg capture, ffplay playback, barge-in: stop playback on
      `input_audio_buffer.speech_started`) _(`audio.ts` — written, compiles,
      but not exercised with a real mic yet)_
- [x] `pnpm cli voice chat` wiring + docs blurb
      _(`voice` namespace on the OS CLI; docs in `scripts/voice/README.md`
      rather than apps/os/docs — it's a prototype)_
- [x] end-to-end demo transcript in text mode against local dev (committed to
      the PR body, not the repo) _(see PR #1591 body)_
- [ ] (stretch) try real Grok voice with a real mic — needs `XAI_API_KEY` in
      doppler and a human with a mouth; leaving for Misha

## Open questions for Misha

- Should the worker agent's _conversation memory_ be the voice transcript
  verbatim, or only the forwarded turns? (Currently: only forwarded turns —
  the agent keeps its own history because it's a stream; the voice side keeps
  its own. "Full conversation history" forwarding can be added by prefixing
  the transcript-so-far, but it doubles tokens and the agent history already
  accumulates.)
- Is `$0.05/min` Grok pricing acceptable for playing around, or should the
  default stay OpenAI realtime since the key already exists?

## Implementation log

- (start) worktree created off origin/main at b1fb37f95.
- Grok Voice Agent API researched: `wss://api.x.ai/v1/realtime?model=grok-voice-latest`,
  OpenAI Realtime-compatible wire protocol, voices eve/ara/rex/sal/leo,
  `$0.05/min`. Also has a `force_message` item type (verbatim TTS injection) —
  not used, but handy if paraphrasing annoys.
- Built `apps/os/scripts/voice/{realtime,audio,bridge,cli}.ts` + README.
- Gotcha: the CLI command resolving ends the process (trpc-cli) and disposes
  the `using` itx handles — the bridge originally returned right after wiring
  the REPL and died silently. Now stays pending until the conversation ends.
- E2E (text mode, local dev, OpenAI Realtime): greeting + "list files in my
  project repo" both forwarded; worker codemode agent listed the real seeded
  repo files; report injected; voice agent relayed them. In the same run the
  voice model also spontaneously called `ask_assistant` (acked, deduped).
- `--forward tool` run: voice model said "Sure, let me get that going" and
  never called the tool. Request never reached the worker. QED on the
  motivation for client-side forwarding.
- Untested: audio mode (mic/speakers), Grok provider (no `XAI_API_KEY`).
- Worker prompt-following niggle: it replies to pure chit-chat instead of
  "(idle)" sometimes — harmless (the voice agent gets a redundant report),
  could be tuned via agent instructions later.
- Live testing (Misha, real mic) found and fixed: EPIPE crash on barge-in
  (ffplay stdin write race), assistant/status line interleaving, and a wedged
  agent after a dev-server reload killed an in-flight LLM request server-side
  (platform bug — interrupted requests never resume; workaround is a fresh
  agent path).
- **Web version added** at `/projects/<slug>/voice` in the dashboard
  (`src/routes/_app/projects/$projectSlug/voice.tsx` +
  `src/components/voice/voice-session.ts` + `src/lib/voice-server-fns.ts`).
  Ephemeral OpenAI client secret minted server-side (raw key stays on the
  server; browser authenticates the realtime ws via the
  `openai-insecure-api-key.<ek_…>` subprotocol — verified empirically).
  Browser echo cancellation replaces the CLI's biggest audio weakness.
  Verified end-to-end via Claude-in-Chrome: minted session → voice page →
  text-mode conversation → worker listed real repo files → stream view shows
  the worker journal. Mic path needs a human (same as CLI).
- Idleness pass after live testing: voice-scoped worker prompt (idle unless
  the turn needs project access; never general knowledge), don't-re-announce
  instruction, and a `no_comment` tool (a function-call response produces no
  audio — structurally guaranteed silence for redundant reports).
- **Refactored to the stream-processor pattern** (Misha: "make it conformant").
  New domain `apps/os/src/domains/voice/` — contract + implementation, slug
  `voice`, registered on every agent host (like slack-agent) and subscribed at
  birth for `/agents/voice/**` paths via the project processor, which also
  gives those agents a dedicated `VOICE_AGENT_SYSTEM_PROMPT` (replacing the
  first-message instruction envelope). Clients are now dumb pumps: they append
  `voice/user-turn-transcribed` (+ `voice/assistant-utterance-completed` and
  `voice/report-suppressed` audit facts) and relay `voice/say-requested`
  projections. The processor renders turns into `agent/input-added` and
  projects non-"(idle)" `agents/web-message-sent` replies into say-requests —
  so forwarding survives client death, reply dedup is structural (the fold
  visits each event once), and the whole conversation (both sides) is in the
  journal. Verified: CLI text mode (file listing via codemode), the journal
  shows the full conformant chain (user-turn-transcribed → input-added →
  llm-request → web-message-sent → say-requested → assistant-utterance), and
  the web page end-to-end in Chrome. Neat proof of the pattern: the first
  turn landed at offset 4 before the subscriptions (offsets 5–9) and was
  still processed, because state is a fold from offset 0.

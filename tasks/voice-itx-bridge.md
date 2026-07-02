---
status: in-progress
size: medium
branch: mmkal/26/07/02/voice-itx-bridge
---

# Voice ↔ itx bridge: `ask_assistant` multiplexer prototype

## Status summary

Spec fleshed out from a loose prompt; implementation starting. Nothing built yet.

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
   `ask_assistant` function tool is *also* registered so that if the voice
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

- [ ] task file fleshed out and committed first
- [ ] realtime client (thin ws wrapper, Grok/OpenAI dialects, session.update
      with instructions + ask_assistant tool + server VAD)
- [ ] itx assistant lane (connect, sendMessage on turn end, stream-watch for
      web-message-sent replies, inject + response.create)
- [ ] `ask_assistant` tool completion path (function_call_output ack + dedupe)
- [ ] `--text` REPL mode
- [ ] audio mode (ffmpeg capture, ffplay playback, barge-in: stop playback on
      input_audio_buffer.speech_started)
- [ ] `pnpm cli voice chat` wiring + docs blurb in apps/os/docs
- [ ] end-to-end demo transcript in text mode against local dev (committed to
      the PR body, not the repo)
- [ ] (stretch) try real Grok voice with a real mic — needs `XAI_API_KEY` in
      doppler and a human with a mouth; leaving for Misha

## Open questions for Misha

- Should the worker agent's *conversation memory* be the voice transcript
  verbatim, or only the forwarded turns? (Currently: only forwarded turns —
  the agent keeps its own history because it's a stream; the voice side keeps
  its own. "Full conversation history" forwarding can be added by prefixing
  the transcript-so-far, but it doubles tokens and the agent history already
  accumulates.)
- Is `$0.05/min` Grok pricing acceptable for playing around, or should the
  default stay OpenAI realtime since the key already exists?

## Implementation log

- (start) worktree created off origin/main at b1fb37f95.

# voice — realtime voice ↔ itx bridge (prototype)

A voice conversation (Grok Voice Agent API, or OpenAI Realtime — the wire
protocols are compatible) multiplexed with an itx worker agent that does the
actual work. Realtime voice models are unreliable tool callers, so the bridge
doesn't depend on them calling tools: it forwards every completed user turn to
the worker agent client-side, and injects the worker's replies back into the
voice conversation as `[worker report] …` items for the voice agent to relay
out loud. An `ask_assistant` function tool is registered too; if the voice
model calls it, the call is acked immediately and the report follows.

```
you (mic/text) ──▶ realtime ws ──▶ transcript of your turn
                                       │ forwarded on every turn end
                                       ▼
                            itx agent.sendMessage(...)
                                       │ codemode snippet runs
                                       ▼
                    events.iterate.com/agents/web-message-sent
                                       │ injected as "[worker report] …"
                                       ▼
                  voice agent speaks: "ok, got some results for you"
```

## Usage

```bash
# text mode (no mic needed), throwaway project, local dev server
pnpm cli voice chat --text --create-project

# real voice against an existing project on prod
doppler run --config prd -- pnpm cli voice chat --project prj_123

# force the tool-calling lane to see how bad it really is
pnpm cli voice chat --text --create-project --forward tool
```

Provider selection: `XAI_API_KEY` present → Grok, else `OPENAI_API_KEY` →
OpenAI Realtime; `--provider grok|openai` overrides. Audio mode needs `ffmpeg`
and `ffplay` on PATH (mic capture is macOS avfoundation only; `--mic ":0"`
picks the device). `--text` is a stdin REPL over the identical multiplexing
path.

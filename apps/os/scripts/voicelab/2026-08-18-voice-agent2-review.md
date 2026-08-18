# voice-agent2.ts under sixteen pairs of eyes — 2026-08-18

Scope: `config-repo/voice-agent2.ts` and its satellites (`pcm.ts`, the contract,
`voice-agent2.test.ts`). Produced by a 16-agent review: three independent
architecture lenses (simplification, bugs, platform idioms), two provider
research agents against live docs (OpenAI GA + grok; Gemini Live), one
platform-mechanism dig for the tools design, one design agent, and seven
adversarial verifiers — every claimed bug was attacked by a fresh agent told to
refute it. Six of seven survived. Line numbers reference the file as of
`675a77ee9`.

## Are we being crazy? (asked three ways, answered three times: no)

All three architecture lenses independently reached the same verdict: **the
fundamental shape is right and hard-won**. Every simpler-looking alternative is
one this file already tried and measured out — provider events routed through
the stream lane cost a full round trip before the first word; client-side
smarts produced boards that muted themselves; unpaced sends dropped 41 s of
speech silently; boolean flushes made the counter stutter. The third switch is
the honest answer to a platform that has no shape for a long-lived outbound
WebSocket inside a facet, the call-as-obligation fold is exactly the doctrine's
form, and the device wire boundary is drawn correctly (the Gemini lens
confirmed this from the outside: a completely different provider dialect
touches _nothing_ on the device side).

The disease is not architecture. It is:

1. **26 runtime `#`-fields with three lifetimes reset by four disagreeing
   hand-lists** — `#hangUp` resets 6, the dial block 19, `response.created` 7,
   and the fields in nobody's intersection are exactly where the last two
   stale-state bug hunts ended (and where three of this review's six confirmed
   bugs live).
2. **Discipline gaps against the platform** — 13 floating `void append(...)`
   with zero uses of `blockProcessorWhile`; a `for(;;)` daemon inside a
   primitive designed for settling attempts; a warmup handshake duplicating a
   barrier the platform has since grown.

## Six confirmed bugs (each survived an adversarial refutation attempt)

**B1 — a rejected `call-started` append wedges the incarnation deaf, silently**
(`:1113-1119`, `:984-988`, medium). `#callRequested = true` then `void
append(call-started)` with no catch. The verifier confirmed the platform's
append is a plain rejectable promise with no retry layer and processEvent has
already acked the delivery. If that one append rejects, `#callRequested` can
never clear (its only clear requires the fold the failed append would have
produced), every subsequent mic frame is silently held-then-dropped, and the
caught-up recovery pass never fires because `state.call` is null. Fix: settle
`call-started` deliberately — `.catch(() => { this.#callRequested = false; })`
at minimum, or ride `blockProcessorWhile` like the doctrine's settlement case.

**B2 — a thrown `dialProvider` fetch is unhandled: no obituary, 60 s of dead
air** (`:1306-1318`, `:2070`, medium). The dial path handles the resolved-null
refusal but not a _rejected_ fetch (DNS/TLS). The runner catches the escape and
only console.errors — no event, no retry. A completed PTT turn sits in
`#micQueue` with `#turnEndedDuringHandshake` set and nothing ever re-dials
(re-dial needs an incoming delivery). Fix: try/catch around the dial treating a
throw exactly like null (append `dial-failed` end-request).

**B3 — the open-mic barge path (the boards' only path) lacks truncate and the
heard-prefix note** (`:1462-1480` vs `:1151-1208`, medium). The whole barge
chain built this week — deferred truncate, heard-prefix system note — lives
only in the ptt-start arm. `input_audio_buffer.speech_started`, the only barge
signal an open-mic board ever produces, calls just `#dropAnswerInFlight`, so a
barged board answer leaves the model believing it said everything it generated.
The verifier refuted the _residue-resume_ half (OpenAI's `interrupt_response`
defaults true and cancels server-side; grok bursts and is done anyway) but
confirmed the memory-repair half. Fix: extract the truncate+note block and call
it from both arms — noting grok drew errors on VAD-triggered `response.cancel`
(`:1786-1791`), so the move needs a live grok re-proof.

**B4 — one false VAD onset still destroys the unsent tail of a grok answer**
(`:1888-1889` via `:1479`, medium). The file's header celebrates that a false
onset costs "one flush and four no-ops" — true for the _device's_ buffer, false
for the facet's own `#speakerQueue`: grok bursts a 40 s answer up front, the
pacer holds ≤4 s on the device, so ~36 s sits only in the local queue, and
`speech_started` — documented five-per-turn tentative, fired by echo residue —
empties it unconditionally. Nothing refills; the answer stops mid-sentence
after the 4 s head start. This is the original "counts to four, stops" symptom
surviving in a second form. Fix direction: don't destroy the local queue on a
tentative onset — pause the pacer and let the _device_ clear ride the numbered
frame only when the onset is confirmed (speech continues / turn commits), or
gate the queue-empty on `#responseActive`-style evidence.

**B5 — the pacer's end-marker await window can strand audio and emit a
premature `lastFrameOfAnswer`** (`:2009-2026`, `:1946-1947`, medium). While the
pacer awaits the marker append, `#sending` is still true: a delta landing in
that window queues but starts no pacer; a `response.output_audio.done` landing
there re-sets `#answerEndsWhenQueueDrains` with nobody to consume it. The
finally releases `#sending` with a non-empty queue and no pacer — that audio is
never sent, the next answer's machinery discards it, and the stale flag fires
`lastFrameOfAnswer` mid-next-answer. Also `#answerEndsWhenQueueDrains` is reset
by neither `response.created` nor `#hangUp`. Fix: re-check the queue after the
marker append (loop instead of straight-line), and move the flag into per-answer
state (see S1).

**B6 — a bare `ptt-end` (no call, no start) mints a call and commits an empty
buffer** (`:1098-1131`, `:1436-1438`, medium). The call-opening branch has no
event-type filter: a lone ptt-end — the ephemeral lane is lossy, duplicates
happen — opens a conversation, dials the provider, flushes zero held frames,
then `#askForAnswer` commits an empty input buffer: a provider error plus,
sometimes, an unprompted spoken answer from bare context, and a zombie call
squatting until the 60 s idle deadline. Fix: only ptt-start and mic-frame may
mint a call.

**Refuted, with a finding anyway**: the claim that heard-ms overstates by the
in-flight backlog was killed by the discovery that **`spkBufferedMs` has no
producer anywhere in the repo** — the device-reported branch (`:1161-1164`)
never runs; the schedule fallback always does, and its arithmetic is sound.
That leaves a decision: delete the dead read, or declare it in the ptt-start
contract schema (the idioms lens wants it declared — it is load-bearing _if_
sent) and actually implement the device stamp (the seq-ledger design).

## The simplification ledger

Ranked by value per risk. Net if everything below lands: **roughly −350 lines
in the hot file**, plus a deleted bug class.

**S1 — collapse the 26 runtime fields into two lifetime-scoped objects**
(`#dial`, with `dial.answer` inside it; ~−60 lines, medium risk). The dial
block's 19-field reset, response.created's 7, and `#hangUp`'s 6 each become one
assignment; `#dialInFlight` deletes (`#dial !== null` covers both states); the
three `#providerSocket !== socket` fences become `#dial !== dial` on the
closure's own object — strictly stronger; `#hangUp` can no longer forget a
field. B5's stranded-flag half and the `#pendingTruncate`/`#responseActive`
lingering all die by construction. `#callRequested` and the idle mirror stay
out (their lifetime is the append→fold gap). Tests should pass unchanged.
**This is the one to do first — three of the six bugs live in the class it
deletes.**

**S2 — delete the warmup handshake; the platform grew its barrier** (~−80
lines, medium risk). Since userspace facets shipped, itx exposes
`streams.get(path).subscriptions.get(name).waitUntilProcessed({offset})`, which
forces the same cold build and proves _fold-through-offset_ — strictly more
than the token echo proves. The memory that justified the knock ("hosted
delivery is FILTERED") described the pre-facet lane. Deletes two contract
events, the processEvent case, and setup's anchored-offset dance. Must be
proven on a cold preview facet before landing.

**S3 — turn-timing subsystem: a deletion decision, not a refactor** (~−145
lines + ~100 test lines, owner's call). "INSTRUMENTATION AND NOTHING ELSE" by
its own comment; the latency campaign it served has concluded. Two of its four
numbers remain derivable from the grok-event lane; the mic-frame gap histogram
does not survive deletion. It is the live latency dashboard for any future
regression hunt — delete it or keep it whole, don't half-move it.

**S4 — delete `fromProviderDeltaSeq`** (~−30 lines, medium). "Debugging, not
ordering" per its own docstring; no device reads it; the grok-event lane keeps
coarse correlation via `deltaBytes`. Clean break on the frame payload.

**S5 — delete the `conversation-end-requested` switch arm** (−15, medium). The
caught-up pass at `:1008-1018` performs the identical action first on virtually
every delivery; the arm is a no-op behind the idempotency key. (Keep the
`conversation-ended` arm — that one is load-bearing.)

**S6 — delete the redundant `#turnEndedDuringHandshake` else-arm** (−8, low)
and **S7 — the colo-trace fetch in warmup** (−12, low; moot if S2 lands).

**S8 — append discipline** (+6 lines, fixes B1/B2's class). Socket-listener
appends ride `this.runInBackground(() => append(...))`; settlement appends at
head use one `blockProcessorWhile`; nothing floats.

**S9 — the idle loop is a daemon the keepalive will misclassify** (~+5,
medium). One tracked closure that settles only when the call ends crosses the
keepalive's 90-busy-refire wedge detector after ~15 quiet minutes of a healthy
call: spurious revival passes against a live incarnation and an alarm decayed
toward the 6-hour plateau — meaning a _real_ eviction during a long call gets
its revival hours late. Fix: self-rescheduling tick chain (each 5 s tick its
own settling closure). Needs a long-call soak.

**S10 — the birth certificate is mutable, against the explicit-birth doctrine**
(+15, low). Every setup run appends a new `created` under a fresh key;
doctrine says a second birth is corruption and config-after-birth is an
ordinary event. Split: `created` becomes existence-only under a stable key;
provider config moves to a content-keyed `configured` event.

**Gemini prep bonus**: when the second dialect listener arrives (below), five
OpenAI-only fields (`#pendingTruncate`, `#answerItemId`, `#answerContentIndex`,
`#responseActive`, `#dropDeltasUntilResponseCreated`) migrate into that
dialect's closure — the shared class shrinks again.

**Direction-dependent (not free wins)**: dropping PTT entirely once server VAD
owns turns deletes `clientTakesTurns`, `#turnEndedDuringHandshake`,
`#askForAnswer` and both ptt-end arms (~−150) — but the barge truncate+note
block _moves_ to speech_started rather than deleting (see B3), and it is a
product decision with a hardware re-soak attached.

## Provider features we're not using (research against live docs)

Our `session.update` is clean GA shape — nothing deprecated. What's on the
table, ranked:

1. **Tools** — see the design section; function calling is now built. The
   **remote-MCP session tool** is the second rung: both providers execute MCP
   tools provider-side with _zero_ facet machinery, and every iterate project
   already exposes an MCP server — "the whole project surface" for one
   certificate entry, when wanted.
2. **grok session resumption** (`resumption: {enabled: true}` + re-dial with
   `?conversation_id=`): today an eviction re-dial reconnects the socket but
   the model wakes with total amnesia. Two lines on the dial path. OpenAI WS
   has no equivalent.
3. **`server_vad` knobs we never turned**: `silence_duration_ms` (default
   500 ms — sits inside every turn-end latency we've ever measured);
   **`interrupt_response` defaults TRUE on OpenAI** — meaning on open-mic
   OpenAI _two owners_ cancel a barged answer today (their auto-interrupt plus
   our machinery); it happens to compose but should be pinned deliberately.
   `idle_timeout_ms` gives a server-side "are you still there?" nudge.
4. **`semantic_vad` with `eagerness`** (OpenAI): the stated full-duplex
   destination — semantic end-of-utterance instead of a silence timer. Grok
   support unknown; affects whether turn_detection becomes per-provider.
5. **`noise_reduction: {type: "far_field"}`** (OpenAI): our boards are
   far-field boxes and the 0.85 VAD threshold exists because of echo residue.
   One line; may let the threshold drop.
6. **Input transcription** (both): we durably record what the model said,
   never what the user said. The events would land in the existing default
   mirror arm — zero new machinery, a complete conversation record.
7. **`max_output_tokens`**: nothing caps answer length against a 4-second
   device buffer today.
8. **`reasoning.effort: "none"`** (grok): think-fast-2.0 _thinks_ by default —
   the obvious probe for the measured 1122 ms grok vs 691 ms OpenAI
   first-speech gap.
9. Smaller: `audio.output.speed`; grok `force_message` (zero-latency scripted
   speech — greetings, "one moment" during slow tools); out-of-band responses
   (context-free extraction: end-of-call summaries, memory) — noting the
   heard-prefix note stays `conversation.item.create` (injection ≠ extraction);
   `response.usage` is **already durably recorded** on the grok-event mirror,
   only an instrument that reads it is missing; OpenAI's hard 60-minute session
   ceiling + `truncation: retention_ratio` need a designed story for long
   full-duplex sessions.

A ten-item "grok docs are silent — probe on a live socket" list is in the
research appendix.

## Gemini Live: a different dialect, and _simpler_ where our hardest code is

Full dossier in the appendix. The essentials: WebSocket `BidiGenerateContent`,
client-sends-`setup`-first handshake (inverted), audio in at **16 kHz**
(our mic resampler becomes an identity), out at 24 kHz (pcm.ts's existing bank
handles it), **no cancel / no truncate / no commit verbs at all** — the server
interrupts itself on VAD onset (`serverContent.interrupted`) and manual
`activityStart`/`activityEnd` maps exactly onto push-to-talk (ptt-end becomes
ONE message, not commit+create). Tools are `functionDeclarations` /
`toolCall` / `toolResponse`. Constraints: ~10-minute socket lifetime
(`goAway`), 15-minute audio cap unless `contextWindowCompression` is set (set
it), session resumption handles exist (defer — the close rides our existing
end-requested path). The real risks: Gemini has **no trim-to-heard** (the
heard-prefix note becomes the _only_ memory repair, and its carrier —
`clientContent` with `turnComplete: false` — must be proven live), and a false
VAD onset **cancels generation for real** (grok's was a retractable blip), so
open-mic boards need AEC + low sensitivity proven in a soak.

**Abstraction judgment** (and I concur after reading the wire shapes): not a
translate-to-OpenAI shim — it would synthesize a hello, a commit ack, and a
`response.done` that Gemini never sends, the silent-divergence family we've
paid for. Not an adapter framework either. **A second concrete listener**
(~150 lines) beside the existing one: `PROVIDERS` grows `dialect: "openai" |
"gemini"` and split `inRate`/`outRate`; grok+openai keep today's listener
byte-for-byte; both listeners call the same shared private methods. Target
`gemini-2.5-flash-native-audio` (not 3.1 — its `clientContent` is
seeding-only, killing the note carrier). Pre-existing wart to fix on the way:
setup demands `/secrets/xai` regardless of provider.

## Tools: itx expressions on the birth certificate — designed and BUILT

Landed today (see the commit): the certificate grows one field, `tools` —
plain data, `{name, description, parameters, expression?}`. `expression` is
the platform's own persisted-capability shape (`ItxExpression`: string step =
property read, `[method, ...args]` = call), walked from a **fresh project
root per call** via `env.ITX.get()` — the facet has carried that scoped
binding since userspace facets shipped, and the SDK's own alarm proxy already
dials it from inside the facet. The model's parsed arguments object is the
final function's single argument. **A tool with no expression is a name the
agent already knows how to be** — today exactly `hang_up`, one atomic append
of `conversation-end-requested`, settled at the pacer's drain point so the
goodbye finishes _playing_ (v1's ~100 lines of settle-poll collapse into the
deadline the pacer already keeps). No registry, no new events — the
grok-event mirror already records both directions of every tool call.

Key behaviors: a cancelled response's tool call never runs (residue
discipline — a side effect out of barge residue is the worst failure
altitude); every call is answered — error and 10 s deadline included — because
a silent tool is a model waiting forever; one `response.create` follow-up only
when all parallel outputs are in, the floor is free, and no barge is in
progress; `response.done` now clears `#responseActive` (a latent latch: a pure
function-call response emits no `output_audio.done`, and the stale flag would
have made the next press cancel a ghost). A press during a hang-up goodbye
un-decides the hang-up. Gemini fit: the certificate is dialect-neutral; the
run path is fed by whichever listener owns the socket.

Open questions parked in the design (v1's belt-and-braces `response.done`
function-call sweep — probe the mirror before adding; durable tool obligations
across eviction — deferred; the MCP rung — compose into the same array when
wanted).

## Suggested sequencing

1. **B1/B2/B6 + S8** (append/dial discipline, event-type filter) — small,
   surgical, high-severity-per-line.
2. **S1** (the `#dial`/`#answer` collapse) — deletes the bug class B5 lives
   in; do B5's pacer loop re-check inside it.
3. **B3 + B4 together** (the speech_started barge chain and the tentative-
   onset queue policy) — one design conversation, one grok re-proof.
4. **S2** (warmup → platform barrier), then S4-S7 sweeps. S3 (turn-timing)
   and the spkBufferedMs decision when you say so.
5. Provider quick wins: pin `interrupt_response`, set `silence_duration_ms` +
   `far_field`, probe grok `reasoning: none`, then grok resumption.
6. Gemini: second listener behind the `dialect` tag, PTT mode first, the four
   live proofs before any board sees it.

---

_Appendices: the two research dossiers follow verbatim (provider features;
Gemini Live), for wire shapes and sources._

# Appendix A — provider-features research dossier (verbatim)

# Provider features we are not using (OpenAI Realtime GA + xAI Grok realtime)

Lens: unused provider capability, researched against live docs (developers.openai.com — platform.openai.com now 301s there — and docs.x.ai) on 2026-08-18, compared to our actual wire usage in `apps/os/scripts/voicelab/config-repo/voice-agent2.ts`.

## 0. Baseline: everything we send and handle today

**We send** (voice-agent2.ts): `session.update` (:1395-1413) with `session: { type: "realtime", instructions?, audio: { input: { format: {type:"audio/pcm", rate}, turn_detection: null | SERVER_VAD }, output: { format, voice } } }`; `input_audio_buffer.append` (:1218, :1423); `input_audio_buffer.commit` + bare `response.create` (:1746-1747); `response.cancel` (:1192); `conversation.item.truncate {item_id, content_index, audio_end_ms}` (:1194, :1572); `conversation.item.create` with a system `input_text` note (:1862-1877). `SERVER_VAD = { type: "server_vad", threshold: 0.85, prefix_padding_ms: 333 }` (:190).

**We handle** (:1391-1596): `session.created`, `session.updated`, `input_audio_buffer.committed`, `input_audio_buffer.speech_started`, `response.created`, `response.output_audio_transcript.delta`, `response.output_audio.delta`, `response.output_audio.done`, `response.done` (only for the deferred truncate), `error`. Everything else falls to `default` and is only mirrored to the grok-event lane.

**GA-conformance verdict on our session.update: clean.** The nested `session.type: "realtime"` / `audio.input|output` / `turn_detection`-under-`audio.input` shape IS the GA shape; nothing we send is deprecated or beta-shaped. Two portability nits, not bugs: (a) grok's own docs show `turn_detection` at session top level while we send it nested at the OpenAI GA position — live-proven accepted, but it is the one spot where the "deliberate clone" claim rests on x.ai's input tolerance; (b) `threshold: 0.85` was tuned against grok's echo residue (:180-190) — OpenAI's documented default is 0.5, and 0.85 on OpenAI far-field mics is untested.

---

## 1. Tools — the whole reason this product exists, and v2 has none

The v2 setup comment says it outright: "This one has no tools, so it has no capabilities to describe" (:2091). Both providers now carry a full tools surface on the realtime session.

### 1a. Function calling (both providers, GA)

Declare in `session.update` (or per-response in `response.create`):

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "tools": [
      {
        "type": "function",
        "name": "lookup_order",
        "description": "Look up an order by its order number.",
        "parameters": {
          "type": "object",
          "properties": { "order_number": { "type": "string" } },
          "required": ["order_number"]
        }
      }
    ],
    "tool_choice": "auto"
  }
}
```

`tool_choice`: `"none" | "auto" | "required"` or a forced specific function. Call flow (server→client): `response.output_item.added` carrying a `function_call` item → `response.function_call_arguments.delta` (streamed) → `response.function_call_arguments.done` `{call_id, name, arguments}` (arguments is a JSON string). Client returns the result and re-triggers:

```json
{ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": "call_123", "output": "{\"status\":\"shipped\"}" } }
{ "type": "response.create" }
```

Grok documents the identical flow plus **parallel function calling**: multiple `response.function_call_arguments.done` events per turn; execute all, send all `function_call_output` items, then ONE `response.create`. gpt-realtime GA announced **asynchronous function calling** (model keeps talking while a slow tool runs — no extra wire shape, it is model behavior); could not re-confirm the announcement page (403), treat the exact 2.1 behavior as probe-with-a-test, not design-blocking.

Fit for us: `response.function_call_arguments.done` is one more arm of the third switch; running the tool is a `runInBackground` like the dial; the result send is `#sendControl`. The facet's obligation pattern already covers "a tool call I owe an answer to."

### 1b. Remote MCP on the realtime session (both providers, GA) — the facet can stay out of the tool loop entirely

OpenAI (`session.tools` or `response.tools`):

```json
{
  "type": "mcp",
  "server_label": "iterate",
  "server_url": "https://.../mcp",
  "authorization": "Bearer ...",
  "allowed_tools": ["..."],
  "require_approval": "never",
  "headers": {},
  "connector_id": "...",
  "defer_loading": false,
  "server_description": "..."
}
```

The **Realtime API itself executes the MCP tool** — the client never sees a `function_call_output`. Lifecycle events: `mcp_list_tools.in_progress/.completed/.failed`; `response.mcp_call_arguments.delta/.done`; `response.mcp_call.in_progress/.completed/.failed`; approval (if not `"never"`) arrives as an `mcp_approval_request` item, answered with `conversation.item.create {type:"mcp_approval_response", approval_request_id, approve:true}`.

Grok has the same tool type: `{ "type": "mcp", "server_url", "server_label", "allowed_tools", "authorization" }` (no `require_approval`/`connector_id` documented — unknown, must probe).

Fit for us: iterate projects already expose an MCP server (`cli claude-mcp`). Pointing the provider at the project's MCP URL gives the voice agent the project's whole capability surface with ZERO facet machinery — no third-switch arms, no obligations, no tool state in reduce(). This is the maximally-deleting design: the session.update grows one array entry sourced from the birth certificate, and tool audit lands on the grok-event lane for free since unknown event types are already mirrored (:1686-1706). Cost to weigh: the provider dials our MCP server from outside (auth = born project API key), and per-call latency/behavior is theirs, not ours.

### 1c. Grok built-in tools (grok only)

Same `tools` array: `{"type":"web_search","allowed_domains":[...],"location":{"country":"US"}}`, `{"type":"x_search","allowed_x_handles":[...],"from_date":"YYYY-MM-DD"}`, `{"type":"file_search","vector_store_ids":[...],"max_num_results":10}`. Instant "ask the assistant about the world" for one session.update line. OpenAI realtime: web search not documented on realtime sessions — unknown, must probe.

---

## 2. Turn detection: the knobs under the interaction model we're heading toward

### 2a. `server_vad` fields we omit (OpenAI GA shape)

```json
{
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 500,
  "create_response": true,
  "interrupt_response": true,
  "idle_timeout_ms": 6000
}
```

- **`silence_duration_ms`** (default 500): THE turn-end latency knob on the open-mic path — it sits inside every measured end-of-speech→first-delta number. We've never set it. Grok documents it too (0–10000).
- **`interrupt_response`** (OpenAI; default **true**): on `speech_started` OpenAI auto-cancels the in-flight response server-side. Our barge machinery was built on the measured fact that _grok_ has no such thing ("`response.cancel` came back as an error every time it was tried", :1786-1790) and assumes it owns cancellation. On OpenAI open-mic, TODAY, two owners cancel: OpenAI's auto-interrupt and our `#dropAnswerInFlight`. It happens to compose (the cancelled response still emits `response.done`, so the deferred truncate still fires) but it is an undesigned interaction. Decision to make explicit: send `"interrupt_response": false` on OpenAI to pin single-owner semantics, or lean on it and delete our `response.cancel` send on the VAD path.
- **`create_response`** (OpenAI; default true): we silently rely on the default for open-mic answering (:1758 "server VAD answering on its own"). Grok: not documented — unknown, must probe whether grok honors it.
- **`idle_timeout_ms`** (both providers): OpenAI — measured after the last response's audio finishes playing; on expiry the server emits `input_audio_buffer.timeout_triggered`, commits an empty audio item, and generates a response (an "are you still there?" nudge). Grok documents the field in `turn_detection` but not its semantics — probe. This is a re-engagement feature, complementary to (not a replacement for) our facet-side 60s hangup (:248, :1610-1666): theirs speaks, ours ends the call.

### 2b. `semantic_vad` (OpenAI only)

```json
{ "type": "semantic_vad", "eagerness": "auto" | "low" | "medium" | "high", "create_response": true, "interrupt_response": true }
```

A semantic end-of-utterance classifier instead of a silence timer; `eagerness` tunes the max wait (low/medium/high ≈ 8s/4s/2s). This is precisely the "OpenAI-app feel" named as the destination for full-duplex. Grok: not documented — unknown, must probe (their model card mentions nothing).

### 2c. `audio.input.noise_reduction` (OpenAI)

`{ "type": "near_field" | "far_field" }` (nullable). Our boards are far-field speaker-mic boxes with real echo problems — the 0.85 threshold exists because of echo residue. `"far_field"` is a one-line add on the OpenAI path and may let the threshold come back down. Grok: not documented — unknown, must probe.

---

## 3. Input transcription — we record what the model said, never what the user said

We already durably keep the _assistant_ transcript (`response.output_audio_transcript.delta`, :1482). The user's side is silence in the event log.

- **OpenAI** (`audio.input.transcription`): `{ "model": "gpt-live-transcribe" | "gpt-transcribe", "prompt", "keywords": [...], "languages": [...], "delay" }`. Events: `conversation.item.input_audio_transcription.delta`, `.completed` (and `.failed`). Optional `include: ["item.input_audio_transcription.logprobs"]`.
- **Grok** (`audio.input.transcription`): `{ "language_hint": "BCP-47", "keyterms": [...] }` — no model field documented; server emits the xAI-extension `conversation.item.input_audio_transcription.updated` (cumulative user transcript; docs tie it to "grok-transcribe" — exact enabling knob unknown, must probe).

Value here: a durable both-sides conversation record on the stream for instruments, history, and future memory — the events land in our existing `default:` mirror arm with zero new machinery; reading them is the only new code. Also feeds a _user_-heard-prefix analogue if we ever want it.

## 4. Answer shaping

- **`max_output_tokens`** (session or per-response; number 1–4096 or `"inf"`): bound answer length. On a 4-second device buffer and a small speaker, an unbounded answer is a product bug; today nothing caps it. Grok: not documented — probe.
- **`audio.output.speed`**: OpenAI 0.25–1.5 (default 1), grok 0.7–1.5. Playback-rate knob with no client change (server ships slower/faster PCM).
- **Voices**: OpenAI `alloy ash ballad coral echo sage shimmer verse marin cedar` or custom `{id}`; grok built-ins ("eve" etc.) plus Custom Voices API IDs. Our `providerVoice` birth-certificate override already carries any of these — nothing to build.
- **Per-response instruction override** (both): `{"type":"response.create","response":{"instructions":"…this turn only"}}` — one-turn behavior changes without touching session instructions.

## 5. Out-of-band responses (OpenAI GA; grok unknown — probe)

`response.create` accepts a full response object:

```json
{
  "type": "response.create",
  "response": {
    "conversation": "none",
    "output_modalities": ["text"],
    "instructions": "Classify the user's last utterance…",
    "input": [
      /* explicit context items; [] = none */
    ],
    "metadata": { "purpose": "summary" }
  }
}
```

Runs a response outside the default conversation — it never enters context and never speaks. Uses for us: end-of-call summaries onto the stream, intent classification, memory extraction — all over the SAME socket with the conversation's full context available via default `input`. It is NOT a replacement for the heard-prefix system note (:1848-1881): that note is context _injection_, which is exactly what `conversation.item.create` is for; out-of-band is context-free _extraction_. Keep the note.

## 6. Session lifetime — one gap this directly exposes

- **OpenAI**: hard 60-minute session max on WebSocket; automatic context truncation when input exceeds the window, tunable via `truncation`: `"auto" | "disabled"` or `{ "type": "retention_ratio", "retention_ratio": 0.8, … }` (drops down to 80% in one cut — fewer truncations, better prompt-cache hits). GA also auto-drops audio tokens where a transcript exists.
- **Grok**: no documented session duration limit — unknown, must probe. But grok has the feature we actually need: **session resumption**. `session.update` with `"resumption": {"enabled": true}`; `conversation.created` returns a `conversation.id`; re-dial with `?conversation_id={id}` and the server replays prior context (cached 30 minutes). Today an eviction/re-dial rebuilds the socket but the model wakes with TOTAL AMNESIA — held mic frames are replayed (:1420) but the conversation isn't. Resumption closes that with two lines on the dial path plus one field on the birth-certificate-adjacent state. OpenAI WS: no equivalent documented — probe/absent.

## 7. Free instrument we already record but never read

`response.done` carries `response.usage` (input/output token counts with cached-token and audio/text detail). Our `#forwardProviderEvent` mirrors `response.done` VERBATIM onto the grok-event lane (:1686-1706 — only `response.output_audio.delta` is stripped to `deltaBytes`). Per-turn cost accounting is therefore already durable on every stream; no wire change, just an instrument that reads it. (`rate_limits.updated` similarly lands in the default mirror unread; grok explicitly never emits it.)

## 8. Smaller / situational

- **`conversation.item.retrieve`** (OpenAI only) → `conversation.item.retrieved` with the server's post-noise-reduction, post-VAD audio for an item. Debug-grade: lets an instrument hear what the model heard. Grok: explicitly absent.
- **Grok `force_message`**: `conversation.item.create` with `item: {type:"force_message", role:"assistant", "interruptible": false, content:[{"type":"output_text","text":"…"}]}` — scripted line TTS'd in the session voice, bypassing the model (no `response.create` after). Zero-latency canned speech: greetings, "one moment", compliance lines. OpenAI: no equivalent documented.
- **Grok `replace`** (session): `{"Acme Mobile": "Acme Mobull"}` pronunciation overrides, case-insensitive whole-word.
- **Grok binary transport**: `audio.{input,output}.transport: "binary"` — raw codec bytes as WS binary frames instead of base64-in-JSON on the provider leg only (our device wire unchanged). Deletes base64 encode+decode per delta in the facet. Also `audio/opus` — irrelevant, fleet is 16k PCM by decision.
- **Grok `reasoning.effort`**: `"high"` (default) | `"none"`. grok-voice-think-fast-2.0 THINKS by default; `"none"` is the obvious probe for the measured 1122ms grok vs 691ms OpenAI first-speech gap. OpenAI 2.1 likewise has reasoning ("reasoning token support"; third-party docs say `reasoning.effort` with `minimal|low|medium|high` and possibly `xhigh` on 2.1-mini routing) — exact OpenAI session placement not in the model page, probe before designing against it.
- **Image input** (gpt-realtime-2.1 accepts text+audio+image): pending StackChan camera work could drop frames into the conversation; exact realtime `input_image` item shape not confirmed — probe. Grok: audio/text only.
- **OpenAI `prompt`** (`{id, version, variables}`) server-stored prompts, and **`tracing`** (`"auto"` or `{workflow_name, group_id, metadata}`): platform conveniences; our birth-certificate instructions already do the first job, and tracing exports to OpenAI's dashboard, not our lane.
- **`input_audio_buffer.clear`** (both): discard uncommitted input; a PTT press-cancel gesture would want it. Currently unused and currently unneeded.
- **Grok ephemeral client secrets** (subprotocol `xai-client-secret.{token}`): for browser/device-direct dialing — irrelevant while the facet owns the socket, and doctrine says it should.

## 9. Grok unknown-must-probe list (docs are thinner; one line each to test against a live socket)

1. `create_response` / `interrupt_response` honored in `server_vad`? (our comment says interrupt does not exist — re-verify on think-fast-2.0)
2. `semantic_vad` accepted at all?
3. `idle_timeout_ms` semantics — who speaks, what event fires?
4. `max_output_tokens`? `truncation`? session duration ceiling?
5. Out-of-band `response.create {conversation:"none"}`?
6. `noise_reduction`?
7. `require_approval` on MCP tools? approval flow at all?
8. `response.done.usage` populated?
9. Nested `audio.input.turn_detection` vs their documented top-level `turn_detection` — which is canonical, is the other going away?
10. How to enable `grok-transcribe` / the `input_audio_transcription.updated` cadence.

Sources: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad), [Realtime client events reference](https://developers.openai.com/api/reference/resources/realtime/client-events), [Realtime server events reference](https://developers.openai.com/api/reference/resources/realtime/server-events), [Realtime with tools / MCP](https://developers.openai.com/api/docs/guides/realtime-mcp), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [gpt-realtime-2.1 model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [2.1 announcement thread](https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896), [Developer notes on the Realtime API](https://developers.openai.com/blog/realtime-api), [xAI Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [MCP tool guide](https://cookbook.openai.com/examples/mcp/mcp_tool_guide), [gpt-realtime-2.1 coverage](https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/).

# Appendix B — Gemini Live dossier (verbatim)

# Gemini Live API — deep-dive and fit against voice-agent2

Reviewed against `apps/os/scripts/voicelab/config-repo/voice-agent2.ts` (whole file), `pcm.ts`, and the current Google docs (`ai.google.dev/gemini-api/docs/live*`, `/api/live`, `/docs/ephemeral-tokens`, `/docs/live-tools`), August 2026.

## TL;DR

Gemini Live is a genuinely different dialect, not a clone. It is _simpler_ than OpenAI's realtime API in exactly the places our hardest machinery lives (no cancel verb, no truncate verb, no commit verb, server-side interruption), and _different_ in framing (no `type` field; the message kind is which top-level key is present; one message can carry several of our reactions at once). About half of our provider-facing code maps one-to-one; the other half — `response.cancel`, `conversation.item.truncate`, `#pendingTruncate`, `#answerItemId` — has **no wire representation at all** and must not be translated, because a translator would have to invent events that never happened. The right shape per house rules is a second concrete socket-listener function beside the existing one, sharing the provider-neutral lanes through the same private fields; the PROVIDERS table survives with a dialect tag and split in/out rates.

## 1. Connection and setup

- **Endpoint (fixed path, no model in URL):**
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- **Auth, server-to-server:** plain API key (`x-goog-api-key` header, or `?key=` query param). Google explicitly says _not_ to use ephemeral tokens for backend connections. Ephemeral tokens (`POST /v1beta/auth_tokens`, `expireTime` default 30 min, `newSessionExpireTime` default 1 min, connect via `access_token` query param or `Authorization: Token <t>`) exist for browser/device clients dialing Google directly — irrelevant to us, since only the facet dials.
- **API version:** the Live surface is on **v1beta** now (endpoint path embeds it; ephemeral tokens too). The old "native audio needs v1alpha" era is over for the mainline models.
- **Models (native audio; the half-cascade `gemini-live-2.5-flash-preview` line has vanished from current docs):**
  - `gemini-2.5-flash-native-audio-preview-12-2025` — current workhorse; supports async (`NON_BLOCKING`) tools, mid-session `clientContent`, proactive audio.
  - `gemini-3.1-flash-live-preview` — newest; `thinkingLevel` control, **but** `clientContent` restricted to seeding initial history, sync-only tools, multiple parts per server message.
- **Handshake is inverted relative to OpenAI.** There is no server hello. The client sends **`setup` as the first message** and waits for the single **`setupComplete`**:

```json
{
  "setup": {
    "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } } }
    },
    "systemInstruction": { "parts": [{ "text": "..." }] },
    "realtimeInputConfig": { "automaticActivityDetection": { "disabled": true } },
    "outputAudioTranscription": {},
    "inputAudioTranscription": {},
    "contextWindowCompression": { "slidingWindow": {} }
  }
}
```

Config is immutable for the life of the connection (no `session.update` mid-call — irrelevant to us, we configure once anyway). ~30 HD voices (Kore, Puck, Zephyr, …), auto language.

## 2. Audio

- **Input:** raw little-endian PCM16, natively **16 kHz**, sent as
  `{"realtimeInput": {"audio": {"data": "<base64>", "mimeType": "audio/pcm;rate=16000"}}}`.
  Other rates are accepted and resampled server-side if the mimeType declares them. **Our fleet is 16 kHz fixed — the mic resampler becomes an identity for Gemini** (it already is for grok; only OpenAI pays 16→24).
- **Output:** PCM16 at **24 kHz**, base64, addressed at
  `serverContent.modelTurn.parts[].inlineData.data` with `mimeType: "audio/pcm;rate=24000"`.
  Same 24→16 downsample OpenAI already forced us to do properly — `pcm.ts`'s polyphase resampler handles it unchanged (the 24→16 bank is literally the cached one).
- **No item identity on deltas.** There is no `item_id`/`content_index`; audio is just parts of the current model turn. (Fine — we only read those for truncate, which doesn't exist here.)

## 3. Turn taking

- **Automatic VAD (default — our boards' open-mic mode):** stream `realtimeInput.audio` continuously; the server segments turns and answers on its own. Config:

```json
"realtimeInputConfig": {
  "automaticActivityDetection": {
    "disabled": false,
    "startOfSpeechSensitivity": "START_SENSITIVITY_LOW|HIGH",
    "endOfSpeechSensitivity": "END_SENSITIVITY_LOW|HIGH",
    "prefixPaddingMs": 20,
    "silenceDurationMs": 800
  },
  "activityHandling": "START_OF_ACTIVITY_INTERRUPTS | NO_INTERRUPTION"
}
```

Note the knobs: **sensitivity is a coarse enum, not grok's 0–1 threshold.** Our `SERVER_VAD = {threshold: 0.85, prefix_padding_ms: 333}` (voice-agent2.ts:190) has no direct translation; the echo-residue tuning that produced 0.85 has to be redone on hardware in enum space.

- **Manual activity (our push-to-talk, exact fit):** set `automaticActivityDetection.disabled: true`, then
  `{"realtimeInput": {"activityStart": {}}}` → audio blobs → `{"realtimeInput": {"activityEnd": {}}}`.
  **`activityEnd` alone triggers the answer** — there is no `input_audio_buffer.commit` and no `response.create`. `#askForAnswer` (voice-agent2.ts:1745-1749) collapses from two sends to one.
- **No commit ack.** `input_audio_buffer.committed` (our one pure network-RTT probe, voice-agent2.ts:1458-1460) has no analog; `turn-timing.committedAckAtFacetMs` stays honestly null for Gemini — the schema already permits it.
- `clientContent` (`{"turns": [Content], "turnComplete": bool}`) is the text/history lane: on 2.5 usable mid-session for incremental context; **on 3.1 only for seeding initial history**.

## 4. Interruption — the big semantic difference

- With auto VAD, user speech onset **cancels the in-flight generation server-side** and the server sends `{"serverContent": {"interrupted": true}}`. With manual activity, `activityStart` during generation does the same (default `activityHandling: START_OF_ACTIVITY_INTERRUPTS`). The client's documented duty is exactly what `#dropAnswerInFlight` does: stop playback, clear the queue.
- **This replaces `response.cancel` entirely** — our barge no longer _asks_ for cancellation, it either caused it (`activityStart`) or is told about it (`interrupted`). Pending tool calls are cancelled too, with `toolCallCancellation: {"ids": [...]}`.
- **It does NOT replace truncate.** On interruption "only the information already sent to the client is retained in the session history" — the **received** frontier, not the **heard** one. That is precisely the gap `conversation.item.truncate` closes on OpenAI (we measured received≫heard: 17 s received at cancel with seconds unplayed on the device). Gemini has **no way to trim history to heard-ms**. The heard-prefix system note becomes the _only_ memory repair — and it has no clean carrier either: Gemini has no system role mid-session (roles are `user`/`model`). On 2.5 the note can ride `clientContent` with `turnComplete: false`; on 3.1 that lane is seeding-only and `realtimeInput.text` is the remaining candidate. Whether either makes the model answer the note instead of absorbing it must be proven on a live dial — this is the same class of silent-behavior question that has bitten this file three times.
- **A false VAD onset is far more expensive on Gemini.** Grok's `speech_started` is tentative and non-destructive server-side (five blips per turn measured; each cost us one no-op flush). Gemini's onset **cancels the generation for real, with no retraction**. Our flush watermark makes the client side cheap, but nothing brings back the answer the server already discarded. Open-mic boards with echo residue need the AEC + `START_SENSITIVITY_LOW` proven in a soak before this ships to hardware.

## 5. End of answer, transcription, errors

- `serverContent.generationComplete: true` = model finished generating (maps to `response.output_audio.done` → sets `#answerEndsWhenQueueDrains`); `serverContent.turnComplete: true` = turn fully closed (maps to `response.done` — but nothing waits on it in the Gemini path, since there is no deferred truncate). On interruption you get `interrupted` **instead of** `generationComplete`.
- Transcription: opt in via `outputAudioTranscription: {}` / `inputAudioTranscription: {}` in setup; deltas arrive as `serverContent.outputTranscription.text` / `inputTranscription.text`. Output transcription keeps our arrival-position tagging (`#answerTranscript`, voice-agent2.ts:1482-1496) working verbatim — same lag caveats.
- **There is no `error` server message.** Failures surface as WebSocket closes with a code/reason. Our close listener (voice-agent2.ts:1599-1608) already turns closes into `conversation-end-requested`, but it drops code/reason today; for Gemini that is the _only_ error channel, so capture them into the reason string.
- **One server message can demand several reactions.** A single `serverContent` can carry audio parts _and_ `generationComplete` _and_ transcription (3.1 sends multiple parts per message). The current switch's one-type-one-arm assumption doesn't hold; the Gemini listener must check fields, not dispatch on a name. This also breaks `#forwardProviderEvent`'s `String(grok.type)` framing (voice-agent2.ts:1381, 1686-1706) — the instrument label has to be derived from which top-level key is present, and `inlineData` bytes stripped to `deltaBytes` the same way `delta` is today.

## 6. Tools (not used by this file today, recorded for the future)

`setup.tools[].functionDeclarations`; server sends `toolCall: {functionCalls: [{id, name, args}]}`; client replies `toolResponse: {functionResponses: [{id, name, response}]}`; async via `behavior: "NON_BLOCKING"` + response `scheduling: INTERRUPT|WHEN_IDLE|SILENT` (2.5 only; 3.1 is sync-only); `toolCallCancellation: {ids}` on interruption. Built-ins: `googleSearch` grounding works on both models; code execution / URL context / Maps do **not** work on the current Live models. No automatic tool-response handling — the client must answer every call.

## 7. Session lifecycle — a constraint OpenAI never gave us

- **A WebSocket connection lives ~10 minutes**, then the server terminates it, preceded by `goAway: {timeLeft}`.
- **An audio-only session is capped at 15 minutes** unless `contextWindowCompression: {slidingWindow: {}}` is set at setup (set it — one line, removes the cliff).
- `sessionResumption: {handle}` at setup + periodic `sessionResumptionUpdate: {newHandle, resumable}` messages let a new connection resume the old session's state; handles valid 2 h. Our owed-call/re-dial obligation machinery rhymes with this (an eviction mid-call already re-dials), but resuming _context_ requires holding the newest handle across the re-dial — durable state we don't have. **First cut: skip resumption; a 10-minute close rides the existing close→`conversation-end-requested` path and the next press opens a fresh call.** Under the 60 s idle rule most calls never get near 10 minutes; only a continuously-talking half-hour session notices, and it notices as one clean call boundary.

## 8. Where our code touches the provider, exhaustively

| Ours (voice-agent2.ts)                                                                              | Gemini equivalent                                                                                           |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| dial URL + `?model=` + Bearer header (2054-2079)                                                    | fixed path, model in setup, `x-goog-api-key`, new `/secrets/gemini`                                         |
| wait `session.created` → send `session.update` → wait `session.updated` (1392-1414, 1416-1454)      | send `setup` on open → wait `setupComplete`                                                                 |
| `input_audio_buffer.append` (1216-1221, 1421-1427)                                                  | `realtimeInput.audio` blob, mimeType `audio/pcm;rate=16000`; mic resample = identity                        |
| `SERVER_VAD` threshold 0.85 (190)                                                                   | `automaticActivityDetection` sensitivity enums — retune on hardware                                         |
| ptt-end → `commit` + `response.create` (1745-1749)                                                  | single `activityEnd` (VAD disabled); ptt-start → `activityStart`                                            |
| `response.cancel` + `#responseActive` gate (1181-1192)                                              | deleted — `activityStart`/auto-VAD cancels server-side                                                      |
| `speech_started` → drop (1462, 1479)                                                                | `serverContent.interrupted` → drop                                                                          |
| `conversation.item.truncate` + `#pendingTruncate` + wait-for-`response.done` (1178-1206, 1566-1585) | **does not exist**; dialect-local, stays OpenAI-only                                                        |
| heard-prefix system note (1848-1881)                                                                | `clientContent` user-text turn, `turnComplete:false` (2.5) / `realtimeInput.text` (3.1); needs live proof   |
| `response.output_audio.delta` + `item_id`/`content_index` (1498-1535)                               | `serverContent.modelTurn.parts[].inlineData.data`; no item identity                                         |
| `response.output_audio_transcript.delta` (1482-1496)                                                | `serverContent.outputTranscription.text`                                                                    |
| `response.output_audio.done` / `response.done` (1556-1585)                                          | `generationComplete` / `turnComplete`                                                                       |
| `error` message (1587-1591)                                                                         | none — mine the WS close code/reason                                                                        |
| `input_audio_buffer.committed` RTT stamp (1458-1460)                                                | none — stays null                                                                                           |
| `#dropDeltasUntilResponseCreated` residue fence (1503, 1560)                                        | likely unnecessary (`interrupted` marks the generation's end, not its middle) — verify live before deleting |
| PROVIDERS `rate` single value (159-178) + resampler minting (1347-1348)                             | needs `inRate: 16000, outRate: 24000` — the one asymmetric provider                                         |

**Untouched and shared as-is:** the speaker queue + pacer (`#sendSpeakerAudio`), the numbered clear (`#dropAnswerInFlight` client half), mic hold/flush + `#turnEndedDuringHandshake`, the idle loop, `turn-timing`, the fold, the whole device wire contract. Gemini never sees any of it — that boundary was drawn correctly.

## 9. The abstraction judgment

The "one table + one switch" was never a provider abstraction — it was an abstraction over **OpenAI's dialect**, which grok happens to speak, and the file says so honestly (voice-agent2.ts:151-158). Gemini breaks it at the framing layer, the handshake direction, the turn verbs, and the interruption model. Two shapes were considered:

- **A translate function that renders Gemini as OpenAI events** — rejected. It would have to _synthesize_ events with no wire reality (`session.created` to trigger our own config send, `response.done` so `#pendingTruncate` can fire, an ack that never comes) and to translate `truncate` into silence. Every synthesized event is a place where the mimicry and the reality diverge silently — the exact failure family this stack has paid for repeatedly (a provider waiting forever for a commit that was never owed).
- **A second concrete listener beside the first** — recommended. One `switch` on a `dialect` field where the socket is wired: the existing message listener body becomes the OpenAI-dialect attach (grok + openai, byte-for-byte today's code), and a Gemini attach (~150 lines) speaks its own wire, calling the same shared private methods (`#dropAnswerInFlight`, `#sendSpeakerAudio`, `#reportTurnTiming`, `#sendControl`, mic flush). No interface, no spec-object, no new nouns — two rhyming functions and a string union. As a bonus it _deletes state from the shared class_: `#pendingTruncate`, `#answerItemId`, `#answerContentIndex`, `#responseActive`, `#dropDeltasUntilResponseCreated` are all OpenAI-dialect facts and can live in that dialect's closure, taking their (dense, correct) comments with them.

A pre-existing wart Gemini makes worse: `setupVoiceAgent2` demands `/secrets/xai` with material regardless of provider (voice-agent2.ts:2237-2243) and `health()` reports only `xaiSecretReady` (2196-2214). Already a lie for OpenAI-only streams; with a third provider the gate should check the secret the birth certificate's provider actually dials.

## 10. Must be proven on a live dial before hardware

1. The heard-prefix note carrier (`clientContent` turnComplete:false on 2.5) — does the model absorb it or answer it?
2. Whether cancelled-generation audio residue can arrive after `interrupted` (decides if a residue fence is needed at all).
3. False-onset cost on open-mic boards with echo — Gemini's onset cancels for real; soak with AEC + `START_SENSITIVITY_LOW` per the coupled-constants rule.
4. Handshake latency of `setup`→`setupComplete` vs grok's 973 ms / OpenAI's dial — it feeds `conversation-accepted.handshakeTookMs` and the whole first-word budget.
5. The 10-minute `goAway`→close cadence under a continuously-active call, to confirm the close path ends it cleanly.

## Sources

- [Live API overview](https://ai.google.dev/gemini-api/docs/live) · [Capabilities guide](https://ai.google.dev/gemini-api/docs/live-guide) · [WebSocket API reference (BidiGenerateContent)](https://ai.google.dev/api/live) · [Session management](https://ai.google.dev/gemini-api/docs/live-session) · [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens) · [Tool use](https://ai.google.dev/gemini-api/docs/live-tools) · [Gemini 2.5 native audio model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025) · [Google blog: Gemini 2.5 native audio](https://blog.google/products/gemini/gemini-audio-model-updates/)

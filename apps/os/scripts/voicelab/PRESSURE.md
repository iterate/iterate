# Pressure test: what the bridge does when the provider misbehaves

An adversarial pass over `config-repo/worker.ts` — the userspace server side of
the voice pipe — against a **provider I control**, so the failures a real
provider only produces occasionally could be produced on demand.

Environment: preview-3, project `prj_698c23da57f84d92a9ba5dc959efebec`. Every
number below comes from a run recorded in this document; nothing is reasoned
from the source alone unless it says so.

**Baseline first.** Before touching anything, `voicelab probe --turns 2`
against the real xAI endpoint: call live in 4.1s, both turns answered
("Hello!", "The sky is blue because sunlight scatters off air molecules…"),
clean hangup, `appendErrors=0, reconnects=0`. The system worked before I
started.

---

## What I built

### 1. The provider endpoint is injectable — as an option, not a processor

`StartCallOptions.grokBaseUrl`, defaulting to `https://api.x.ai/v1/realtime`,
threaded through the `startCall` → query-string lane every other knob already
uses.

I was asked to consider a `voice-agent` stream processor whose `created` event
carries the model and base URL. I did not do that, for two reasons that are
about this codebase rather than taste:

- **A processor cannot see this call.** `docs/writing-stream-processors.md`:
  processors never see ephemeral events — the wake lane drops them and
  catch-up reads exclude them. Every frame in this protocol is
  `ephemeral: true`, and the bridge consumes them through
  `stream.openConnection(...)`, which is the live-connection lane, not the
  processor lane. A processor is architecturally unable to participate in the
  call path as built, so it could only be a config side-car.
- **As a config side-car it adds failure modes to the thing under test.** A
  birth certificate is the right shape for immutable, auditable, per-stream
  facts that outlive a call and that other code reads back. "Which endpoint
  does THIS call dial" is none of those; it is per-call, and `StartCallOptions`
  already carries seven such knobs. Making the test harness create a domain
  object before it can point the bridge somewhere would mean a scenario could
  now fail for a reason that has nothing to do with the bridge.

One thing that is _not_ just plumbing: the xAI key is now sent **only to
x.ai**. `grokBaseUrl` is caller-chosen, and a bearer token that follows the URL
wherever it points is a credential waiting to be exfiltrated by anyone who can
call `startCall`.

### 2. A fake Grok that misbehaves on command — `fake-grok.ts`

Speaks enough of the realtime protocol to hold a conversation
(`session.created`/`updated`, binary mic in, binary speaker out, transcripts,
response lifecycle, the `ask_colleague` function tool), and every deviation is
selectable per call with `?script=…` plus per-field query overrides.

**It runs in the test process and is published through captun**
(`https://<name>.tunnels.iterate.com`), not as a route in a deployed worker.
Both were viable — a project worker _can_ be dialled at
`voice--<slug>.iterate-preview-3.app` and `global_fetch_strictly_public` is set
so a same-zone subrequest traverses worker routes. I chose the tunnel because:

- the loop is a process restart (~1s), not a commit-and-rebuild (~30s), and I
  changed the fake's behaviour a dozen times during this work;
- everything the bridge sends the provider is visible **locally**, so "the
  customer heard nothing" resolves to "the provider was handed 0 bytes"
  without instrumenting the code under test;
- one process holds the provider, the stream watcher and the assertions, so a
  scenario physically cannot report a pass for something it did not observe on
  both ends.

### 3. A scenario driver — `pressure.ts`

`pnpm cli voicelab pressure --project prj_… --scenario all` (or `--list`). Each
scenario states what it expects, records evidence from both ends, and returns
`pass` / `DEFECT` / `inconclusive`. `inconclusive` is a real outcome and is
used.

---

## Defects, most likely first

### D1 — A provider that greets promptly is never heard, and the call hangs

**Rank 1.** Pure timing luck decides whether a call works at all.

`dialGrok` calls `socket.accept()` — which starts delivery — and then the code
does `await this.env.ITX.get()`, a real RPC round trip, before `attachGrok`
adds the `message` listener. Anything the provider says in that window is
dropped. `session.created` is the only thing that makes the bridge send
`session.update`, so losing it means the handshake never completes.

```
greeting at 0ms:   startCall {"hung":true} after 25002ms
  provider saw from the bridge: []
greeting at 400ms: startCall {"callId":"pbvgln0","ok":true,"startMs":3945} after 4022ms
  provider saw from the bridge: [session.update]
```

Same provider, same script, one field different. With the greeting at 0ms the
bridge sent the provider **nothing at all** for the whole 25 seconds.

**The customer hears:** they press call and nothing happens. Not an error — the
button's RPC simply never returns. On the current timings the real xAI endpoint
is slow enough to survive this, which is the only reason it has not been seen:
a faster provider region, a warmed connection, a different provider, or a
slower `ITX.get()` flips it. It is a coin whose bias nobody chose.

**Fixed.** The socket is drained into a buffer from the instant it is accepted;
`attachGrok` installs the real handler and inherits everything already queued.

### D2 — There is no handshake timeout: `startCall` blocks for minutes

**Rank 2.** Any provider outage, not just an exotic one.

`startCall` resolves on `session.updated`. The only backstops were
`IDLE_TIMEOUT_MS` (600s) and `MAX_CALL_MS` (3900s), with a redial ladder that
runs to 40 attempts (~3 minutes) underneath.

| scenario                                      | result                                     |
| --------------------------------------------- | ------------------------------------------ |
| provider never sends `session.created`        | `startCall` unanswered after **75002ms**   |
| provider closes during every handshake        | unanswered after **75003ms**, 19 dials     |
| provider closes right after `session.created` | unanswered after **60002ms**, **35 dials** |

75 seconds is only where my patience ran out; the code's own limit is ten
minutes.

**The customer hears:** the assistant is down, and their device sits on
"connecting" for up to ten minutes rather than saying so and offering to retry.

**Fixed.** `HANDSHAKE_TIMEOUT_MS = 15_000`: a call that has never had a session
established is torn down, which resolves `startCall` with `ok:false` and
appends `call-ended` with the reason and the dial count.

### D3 — One malformed frame from the provider kills the call, silently

**Rank 3 by likelihood, rank 1 by damage.** A single bad frame, no recovery, no
diagnosis, no obituary.

`onGrokMessage` did `JSON.parse(event.data)` unguarded, as a WebSocket event
listener inside the invocation that owns the whole call. The fake sent one
truncated JSON frame before an answer:

```
speaker frames: 0
response.done seen: false
second turn answered: false
call-ended: []
session 41 … received=[session.update,conversation.item.create,response.create]
provider sessions: 41   (no redial happened)
```

Read the `received` list: after the bad frame, the customer's **next turn** —
`turn` start, 12 mic frames, `commit` — never reached the provider either. The
throw did not just lose a frame; it took the stream-delivery lane with it. And
because nothing tore down, no `voicelab/call-ended` was appended, so the
listener was never told the call was over.

**The customer hears:** mid-conversation the assistant goes quiet. The button
still lights up. They talk into it; nothing comes back, ever. The device
believes the call is live because nobody said otherwise, and keeps sending
audio into a bridge that stopped listening.

**Fixed.** `handleGrokMessage` is wrapped: unparseable frames and frames
without a `type` are counted (`providerJunk`), handler throws are counted
(`handlerErrors`), and both ride out on `call-ended`. A provider is allowed to
send rubbish; it is not allowed to hang up on the customer by doing it.

### D4 — Stragglers from the previous turn discard the whole next turn, and the diagnostic says it went fine

**Rank 4.** The trigger is barge-in, which is the most common thing a person
does to a voice assistant.

Every turn numbers its mic frames from zero. Frames from turn 1 still in flight
when turn 2 starts therefore arrive carrying numbers hundreds above what turn 2
is sending. They entered the 16-frame reorder window, overflowed it, and the
overflow rule (`micExpected = lowest pending`) dragged the cursor past every
real frame of the new turn — each of which was then rejected as "already sent,
or already given up on".

```
turn 2 spoke 30 frames (19200 bytes) after 20 stragglers numbered 200+;
the provider was handed 12800 bytes of it (20 frames)

turn-committed: {"frames":50,"bytes":32000,"ms":1000,"reordered":17,"late":30,"lost":200}
provider mic bytes per turn: 12800,12800
```

The provider received **none** of what the customer said in turn 2 — only 0.4s
of the tail of turn 1 — and answered anyway.

The second half is worse than the first. `voicelab/turn-committed` exists, in
its own words, so that "a device that speaks and hears nothing back is either
not reaching here (frames 0) or being answered badly (frames fine)". It counted
what **arrived at the bridge**, not what was **handed to the provider**, so in
precisely the case it was built for it reported a confident "50 frames, 32000
bytes, 1000ms of audio". The one instrument aimed at this failure was pointing
the wrong way.

**The customer hears:** they interrupt, say a whole sentence, and get an answer
to something else — because the assistant was answering the last two words of
their _previous_ sentence. Whoever investigates reads `turn-committed`, sees a
second of audio delivered, and concludes the microphone is fine.

**Fixed.** `MIC_MAX_LEAD = 64` frames (~1.3s): a frame numbered further ahead
than that is not a reordering, it is a leftover from a finished turn, and is
dropped (counted as `stale`). And `turn-committed` now reports what the
provider was given (`frames`/`bytes`/`ms`, counted at the send) alongside what
arrived (`arrived`/`arrivedBytes`). When they disagree, the gap is the
diagnosis.

### D5 — Every outstanding colleague question resolves with the same single reply

**Rank 5**, and the one whose failure story is most embarrassing in front of a
customer.

`agent.ask()` is `append(question)` followed by
`waitForEvent({ afterOffset: myAppendOffset, eventTypes: ["…web-message-sent"] })`
(`apps/os/src/rpc-targets.ts:4758`). Its own docstring says replies are "matched
by order, not correlated per request". In practice it is worse than order: with
N asks outstanding, the agent's first reply is after **all N** offsets, so
**all N asks resolve with that one message**.

Driven with the fake emitting `ask_colleague` calls, against the bridge as it
was:

```
asks=22 answers=22 injected=23
every colleague-answered payload: "I can’t answer that because it appears
  to be a placeholder question."   (identical, all 22)
ms per ask: 13046, 12624, 12844, 12181, 13037, 12835, 11971, 11311, …
conversation items injected into the provider, timestamps:
  …772898, …772899, …772900, …772900, …772901, …772901, …772902, …
  (22 identical "Your colleague says: …" items inside 10 milliseconds)
```

Twenty-two questions, one answer, read out twenty-two times. Twenty-one real
answers were never spoken, because no ask was left waiting to receive them.

There is a secondary finding in that trace worth recording on its own: the fake
was asking on every turn, and because **each colleague answer is delivered as a
fresh `response.create`**, the model answered the answer and asked again — 22
questions from one spoken turn in about three seconds. A voice model with a
loose trigger finger can cascade this without any provider misbehaviour at all.

**The customer hears:** "you asked me two things — here's the answer to the
first… and here's the answer to the second", reading the identical sentence
twice. Their second question is never answered and never mentioned again.

**Fixed, in two parts, because numbering alone would have made it worse.**

1. **The questions are numbered.** `ask_colleague` now returns
   `asked as question #n - colleague will get back to you ASAP. you can tell
the human to wait or speak about something else`, with `n` a plain
   incrementing counter (1, 2, 3), and the answer comes back as
   `Your colleague says, on question #3: …`. `VOICE_INSTRUCTIONS` tells the
   model that answers are numbered, that they can arrive late and out of
   order, and that it must say which question it is answering when more than
   one is outstanding.

2. **The correlation is made true, not decorative.** Numbering fixes what the
   model _says_; it does nothing about which answer the bridge _attaches_ to
   which question, and a confident wrong number is worse than no number. The
   platform offers nothing that ties a reply to a request — the payload of
   `web-message-sent` is `{ message, files }` and there is no request id
   anywhere in it, so there was no honest mechanism to reach for. Instead
   there is now **at most one `ask()` in flight per call**, with the rest
   queued: with a single outstanding question, "the agent's next message" is
   unambiguously the answer to it, and the platform's order-matching becomes
   correct by construction rather than by luck. The cost is that a second
   question waits for the first, which is honest, and the model has been given
   the number it is waiting on so it can say so.

   Delivery is a **second** serial lane, so a question does not wait for the
   previous _answer's_ gap-in-conversation to open (which can be up to 60s) —
   only for the previous _ask_ to resolve.

   One residual hazard survives serialisation and is therefore surfaced rather
   than hidden: if the colleague sends **two** messages for one question, the
   extra message lands after the next ask's append and is mis-attributed. The
   colleague's brief now asks it to start every reply with `#n` and send
   exactly one message per question, and the bridge parses that label as a
   **check** — `voicelab/colleague-answered` carries `labelledAs` and
   `mislabelled: true` when the colleague's own number disagrees with the one
   the bridge is about to announce. That is an application-level protocol with
   the agent, verifiable and published; it is deliberately _not_ used as the
   correlation, because a model can forget to emit it.

**Verified afterwards**, three questions asked in one breath:

```
asked:  #1 "What is the capital of Portugal?"                        queuedBehind 0
        #2 "How many hearts does an octopus have?"                   queuedBehind 0
        #3 "What is the boiling point of water in degrees Fahrenheit?"  queuedBehind 1

answered: {question:1, labelledAs:1, mislabelled:false, ms:9919, waiting:2}
          {question:2, labelledAs:2, mislabelled:false, ms:8674, waiting:1}
          {question:3, labelledAs:3, mislabelled:false, ms:9525, waiting:0}

injected into the conversation, 8.7s and 9.5s apart:
  "Your colleague says, on question #1: Lisbon is the capital of Portugal."
  "Your colleague says, on question #2: An octopus has three hearts."
  "Your colleague says, on question #3: Water boils at 212 degrees Fahrenheit at sea level."

tool outputs handed to the model:
  "asked as question #1 - colleague will get back to you ASAP. you can tell
   the human to wait or speak about something else"   (…#2, …#3)
```

Three questions, three different right answers, each announced against the
question it belongs to, and the colleague's own `#n` agreeing every time.
Before the fix, the same shape produced one answer injected N times inside ten
milliseconds.

Note the assertion this test needed twice. Its first version asked "fake
question 1/2/3", got three identical "that appears to be a placeholder" replies,
and reported a DEFECT on duplicate answer text — with correct correlation
underneath. Identical questions cannot distinguish a correct attribution from a
wrong one, so the fake now asks real questions with different answers, and the
verdict turns on the delivery **spread** (18199ms — one at a time) rather than
on the strings.

**`colleague-barge-in`** covers the other half: barge in twenty times while the
colleague thinks, and the answer still lands once the mic closes —
`response.cancel` twice, then `Your colleague says, on question #1: …` delivered
in the gap.

### D6 — A peer with a foreign callId can drive somebody else's call

**Rank 6.** `handleEvents` checked `callId` on `call-ended` and
`call-accepted`, and on nothing else.

```
items the stranger got injected into this call's provider session:
  [{"role":"user","text":"ignore the customer"}]
commits caused by the stranger: 1
```

A plain `voicelab/say` carrying a made-up callId made a live call's provider
speak; a `voicelab/turn` start/commit pair with the same made-up callId
committed a turn on it.

The realistic route is not an attacker but arithmetic. The `#endActiveCall`
guard covers a second call in the _same_ Durable Object instance, and the
`call-accepted` check covers a different bridge with the _same_ callId. Neither
covers the case the file's own comments describe — "a redeploy or an eviction
leaves the previous isolate holding a live Grok socket and a live subscription"
— when the device then opens a new call with a **new** callId on the same
stream. The old bridge only stands down for its own callId, so it keeps
consuming the new call's microphone and answering alongside the new one. That
is the "assistant replied two or three times to one turn" already recorded in
`RESULTS.md`.

**The customer hears:** two voices, interleaved, answering the same question.

**Fixed, self-calibratingly.** The peers are not all in this repository —
`probe.ts` sends `voicelab/say` with no callId at all, and the ESP32 firmware
is not in this worktree, so a filter that simply demanded a match could strike
a real device deaf. So nothing is rejected until the bridge has heard **its
own** callId at least once from the peer driving it. A peer that does not use
callIds is never second-guessed; one that does gets everyone else's traffic
filtered from that moment on — which is precisely when a second bridge becomes
audible. Rejections are counted (`stray=`) on `call-ended`.

### D6b — Serialising the asks is not sufficient on its own, and the fix for D5 announced a wrong number

Found by attacking my own fix, and it is the exact failure the brief warned
about: **"the voice model announcing 'on question #2' while reading the answer
to question #1"**, which is what numbering makes possible when the correlation
underneath is not airtight.

Serialisation makes "the agent's next message" the right answer _for the ask
that is in flight_. It cannot stop an agent that sends a **second** message for
a question it already answered — that message lands after the _next_ ask's
append, so it is that ask's "next message". Driven deliberately, by appending
an unsolicited `agents/web-message-sent` to the colleague's own stream while
question 2's ask was in flight:

```
{question:1, labelledAs:1, mislabelled:false, ms:19938, answer:"Lisbon is the capital of Portugal."}
{question:2, labelledAs:null, mislabelled:false, ms:1763,
 answer:"IGNORE ME — a stray second message about question one."}

injected: "Your colleague says, on question #1: Lisbon is the capital of Portugal."
          "Your colleague says, on question #2: IGNORE ME — a stray second message about question one."
```

And my `#n` cross-check **did not catch it**: `mislabelled` was only true on a
positive disagreement, so an answer with _no_ label — a check that could not run
— was scored as fine and announced with full confidence as question #2.

**The customer hears:** "on your second question — ignore me, a stray second
message about question one." Nonsense, delivered with a number attached, which
is worse than the same nonsense delivered without one.

**Fixed.** The colleague's own `#n` label now decides what is _said_, not just
what is logged:

| the label                      | what the voice is told                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| agrees with the queue position | `Your colleague says, on question #n: …`                                                                                                   |
| positively disagrees           | the **label's** number — the colleague knows what it is answering better than a queue position does — and `mislabelled: true` is published |
| absent                         | `Your colleague says: …` with **no number at all**, and `unlabelled: true` is published                                                    |

`VOICE_INSTRUCTIONS` now covers the third row: a message with no number means
nobody can tell which question it answers, so pass it on without claiming one.
That converts the failure from "confidently announces the wrong question" into
"declines to name a question it cannot vouch for", which is the honest outcome
when no correlation the platform provides can settle it.

### D7 — Speaker audio before `response.created` is labelled with the previous answer

**Rank 7, and deliberately NOT fixed.**

```
answer 0: 20 frames, frame 0..19, 0 discontinuities
answer 1: 75 frames, frame 0..74, 0 discontinuities
frames labelled answer 0 (before any response.created): 20
```

Audio that arrives before its `response.created` inherits **the previous
answer's** number, because `answerSeq` only advances on `response.created`. In
the run above this happened on the call's first answer, so the orphan landed as
"answer 0" and the listener's own rule — drop anything older than the newest
answer number seen — discards it correctly when answer 1 arrives; the customer
loses 0.4s from the head of the answer. Mid-call it is worse in a way I did not
capture: the orphan carries answer N's number with `frame` continuing from
answer N's count, so a listener that has finished answer N appends 0.4s of the
_next_ answer onto speech it has already played.

I chose not to fix it. The obvious fix — "audio while `responseActive` is false
starts a new answer" — would also re-number any trailing chunk that arrives
after `response.done`, which would make the listener discard the tail of a
perfectly good answer. That is a worse defect than the one being fixed, and
picking between them needs to be driven by what the real provider actually does
at answer boundaries, which is a measurement I have not made.

### D8 — A provider that swallows a turn produces silence with no deadline

**Rank 8 — reported, not fixed, because the fix is a product decision.**

With the provider accepting the commit and never answering:

```
session 1 script=no-answer … commits=1 responses=0
  received=[session.update,input_audio_buffer.commit,response.create]
turn-committed: {"frames":25,"bytes":16000,"ms":500,"arrived":25,"lost":0,"stale":0}
anything from the provider in 30s: false
call-ended: []
```

The bridge did everything right — 16000 bytes delivered, the commit and the
`response.create` both sent — and then waited for ever. There is no per-turn
answer deadline anywhere, so nothing is appended to say the turn died. The
customer speaks, and the call is simply silent, indefinitely.

`RESULTS.md` already flagged the shape of this ("~1-in-6 streams-worker calls
wedge mid-call… a product client needs a turn-level timeout+retry"). What the
right behaviour is — retry the commit, tell the customer, end the call — is a
decision about the product, not a bug with an obvious patch, so I have measured
it and left it.

Its sibling **does** recover: `created-then-nothing` (an answer that starts and
never finishes) is a `pass` — the customer's next turn cancels the wedged
response and starts a fresh one (`cancels=1`, second `response.created`
observed). So a _stuck answer_ is escapable by talking again; a _swallowed
commit_ is not distinguishable from thinking.

---

## After the fixes: the same scenarios, re-run

Every defect above was re-driven against the deployed fix with the same script.

| scenario                      | before                                                                                                       | after                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `handshake-race`              | greeting at 0ms → `{"hung":true}` at 25002ms, provider `received: []`                                        | **`{"ok":true,"startMs":2784}`**, provider `received: [session.update]`                                                                  |
| `no-session-created`          | unanswered at 75002ms                                                                                        | **`{"ok":false,"reason":"the provider never completed a session handshake (0 dials)","startMs":18813}`**                                 |
| `close-handshake`             | unanswered at 75003ms, 19 dials                                                                              | **`ok:false … (7 dials)` in 17924ms**                                                                                                    |
| `close-after-session-created` | unanswered at 60002ms, 35 dials                                                                              | **`ok:false … (7 dials)` in 19358ms**                                                                                                    |
| `malformed-json`              | 0 speaker frames, no `response.done`, next turn unanswered, no `call-ended`, call dead                       | **75 speaker frames, `response.done` seen, second turn answered, one provider session, no redial needed**                                |
| `mic-straggler-poison`        | provider handed 12800 bytes of the _previous_ turn, `turn-committed` claimed `frames:50 bytes:32000 ms:1000` | **provider handed 19200 bytes = all 30 frames**; `turn-committed`: `frames:30 bytes:19200 ms:600 arrived:50 arrivedBytes:32000 stale:20` |
| `stale-peer`                  | stranger injected text and committed a turn on a live call                                                   | **`items the stranger got injected: []`, `commits caused by the stranger: 0`**                                                           |
| `colleague-three-questions`   | 22 asks → one answer injected 22× inside 10ms                                                                | **3 asks → 3 different right answers, correctly numbered, 8.7s and 9.5s apart**                                                          |
| `colleague-answers-twice`     | a stray message announced as "on question #2"                                                                | **delivered with no question number, `unlabelled: true` on the stream**                                                                  |
| `close-mid-answer`            | (harness fault, see below)                                                                                   | **provider hung up 1.5s into a paced answer after 19 frames; the next turn was still answered, 2 provider sessions**                     |

And the real provider still works. `voicelab probe --turns 2` against
`api.x.ai` after all of it: call live in 2946ms, both turns answered, hangup
clean, `appendErrors=0, reconnects=0, redials=0, providerJunk=0,
handlerErrors=0`. And with the real Grok model driving the real colleague
through the numbered tool, two questions in one call:

```
 4.6s  startCall {"callId":"7a91daf7","ok":true,"startMs":4044}
 6.4s  VOICE: I've asked my colleague about the population of Lisbon.
 6.4s  TOOL CALL ask_colleague: {"question":"What is the population of Lisbon?"}
 7.8s  VOICE: While we wait, what made you curious about Lisbon's population?
16.7s  COLLEAGUE (10399ms): Lisbon municipality had an estimated 575,739 residents…
19.5s  VOICE: Lisbon municipality had an estimated 575,739 residents at the end of 2024.
26.1s  TOOL CALL ask_colleague: {"question":"what our project id is"}
27.5s  VOICE: While we wait on that, anything else on your mind?
35.3s  COLLEAGUE (9606ms): The project ID is prj_698c23da57f84d92a9ba5dc959efebec.
38.8s  VOICE: The project ID is prj_698c23da57f84d92a9ba5dc959efebec.
```

Two questions, two right answers, no cross-talk, and the model keeps the
customer company while it waits. Note it does not read the numbers out here —
which is correct: the instructions ask it to name the question only when more
than one is outstanding, and these two never overlapped.

---

## Everything that passed, with the evidence that it ran

| scenario                                   | evidence                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **baseline**                               | call live in 3616ms; two turns answered; 150 speaker frames; provider got 16000 mic bytes across 1 commit                                                                                                                                                   |
| **close-between-turns**                    | provider hung up after its answer; the customer's next turn was answered on session 40 (`received=[session.update,…,input_audio_buffer.commit,response.create]`)                                                                                            |
| **provider-recycles** — the ~296s question | provider hung up every 20s: **5/5 turns answered across 4 provider sockets**, 3 history replays into fresh sessions, 3 redial announcements, **0 `call-ended` mid-call**. The redial architecture genuinely carries a conversation across provider hangups. |
| **flood** — 90s of audio in one burst      | **4500/4500 frames delivered, 0 discontinuities**, drained in 13.8s (~326 events/s, well above the ~50/s the protocol produces); call still answering afterwards                                                                                            |
| **long-run** — 60 turns back to back       | 60/60 answered; provider received **960000 mic bytes = 60 × 16000 exactly**; 6000 speaker frames; mean answer latency **2519ms in the first half vs 2518ms in the second**; `lost=0 late=0` across 60 commits; no `call-ended` mid-run                      |
| **junk-events**                            | unknown event types absorbed; the `error` event forwarded to the listener once; answer arrived (75 frames)                                                                                                                                                  |
| **double-created**                         | one spoken answer, answer number 2 throughout — the listener's "drop anything older than the newest number" rule holds                                                                                                                                      |
| **mic-reorder**                            | 40 frames in swapped pairs → provider got 25600 bytes = 40 frames, `reordered:20 lost:0`                                                                                                                                                                    |
| **mic-gap**                                | seq 5 never appended → provider got 39 frames, `lost:1`; the turn still committed                                                                                                                                                                           |
| **mic-duplicates**                         | 20 frames + 10 duplicates → provider got exactly 20 frames, `late:10`                                                                                                                                                                                       |
| **empty-commit**                           | a commit with no frames produced an empty turn; the next real turn was answered                                                                                                                                                                             |
| **turn-never-committed**                   | an abandoned turn's 25600 bytes folded into the next commit; the call answered                                                                                                                                                                              |
| **rapid-barge-in**                         | six barge-ins in four seconds against a 20s **paced** answer: 1 `response.cancel` reached the provider, answer numbers 1→2, **0 non-monotonic frame runs within an answer**                                                                                 |
| **created-then-nothing**                   | an answer that starts and never finishes is escapable: the customer's next turn sent `response.cancel` and started a second `response.created`                                                                                                              |
| **colleague-barge-in**                     | 20 barge-ins while the colleague thought, 2 `response.cancel`; the answer was still delivered in the gap once the mic closed                                                                                                                                |

The final post-fix sweep of the non-colleague scenarios: **12 pass, 1 DEFECT** —
`audio-without-created` (D7), the one deliberately left alone.

### Two scenarios that first reported a pass they had not earned

Recorded because it is the failure mode this whole exercise is supposed to be
immune to, and it happened twice:

- **`rapid-barge-in` v1** reported a clean pass with **0 cancels reaching the
  provider**. The fake was bursting its whole 6s answer in ~100ms, so the
  answer was over before the barge-in landed and there was nothing to cancel.
  Now paced (`burst: 0`, 20s answer), and 1 cancel is observed.
- **`close-mid-answer` v1** reported a pass having delivered **all 400 frames**
  of the answer it was supposed to have interrupted — same cause. Now paced,
  and the close genuinely lands 1.5s into a 20s answer. Its _second_ version
  then failed for a different harness reason (a redial dials the same URL, so
  the replacement provider also closed every answer and no `response.done`
  could ever arrive); the fake now applies the mid-answer close a bounded
  number of times.

Both were caught by asking "what number proves this ran?" rather than by the
pass/fail line.

---

## What I could not test, and what it would take

- **A full hour.** `long-run` is 60 turns over ~4 minutes and `provider-recycles`
  is 4 provider sockets over ~1 minute. Latency was flat and `micBytes` exact
  across both, and the obviously unbounded structures are bounded by
  construction (`history` at 24 lines, `micPending` at the reorder window,
  `answeredToolCalls` at one small string per tool call). The outbound append
  queue was the one thing with no ceiling at all; I added one (see below) but
  never observed it fire. A real hour needs an hour, plus DO memory
  instrumentation the platform does not currently expose to userspace.
- **The `#endActiveCall`-bypassing two-bridge case.** I proved the _enabling_
  condition (D6: unfiltered control events) but not the full scenario, because
  producing two simultaneously-live bridges on one stream requires a redeploy
  or an eviction mid-call — the DO is keyed by stream path, so every route I
  can drive from a script lands in the same instance and is superseded
  correctly. Testing it properly means deploying a new worker version while a
  call is live and checking whether the old isolate still answers.
- **The real device.** Everything here drives the stream directly. The ESP32
  firmware is not in this worktree, which is exactly why the D6 fix
  self-calibrates rather than asserting a callId contract I cannot read.
- **A colleague that never answers, and one that answers after 120s.** The
  colleague is a real LLM agent and I could not make it deliberately silent.
  The timeout path (120s, then "Your colleague could not answer question #n")
  is exercised by construction but never observed. The _other_ half of that
  brief — a colleague that answers **twice** — turned out to be testable after
  all, by appending `agents/web-message-sent` to the agent's own stream from
  the driver (that being precisely the event `ask()` waits for), and it found
  D6b. The same trick would make "never answers" testable with an injectable
  colleague path, which is a small change to `COLLEAGUE_PATH`.
- **Overlapping answers proper.** `double-created` covers two `response.created`
  back to back, but not two answers whose _audio_ genuinely interleaves. The
  fake would need to emit two answers concurrently on one socket, which no real
  provider does — worth adding only if the real one is ever seen to.

---

## Changes made, and changes deliberately not made

Everything below is in `config-repo/worker.ts` unless stated.

| change                                                                                                             | why                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grokBaseUrl` option + `GROK_REALTIME_URL` default                                                                 | the ask; makes every scenario above possible                                                                                                                                                                                                                                                                                                        |
| xAI key only sent to `*.x.ai`                                                                                      | `grokBaseUrl` is caller-chosen; a token that follows the URL anywhere is exfiltratable                                                                                                                                                                                                                                                              |
| buffer provider messages from `accept()`                                                                           | **D1**                                                                                                                                                                                                                                                                                                                                              |
| `HANDSHAKE_TIMEOUT_MS = 15_000`                                                                                    | **D2**                                                                                                                                                                                                                                                                                                                                              |
| `handleGrokMessage` wrapped; guarded `JSON.parse`; `providerJunk`/`handlerErrors` counters                         | **D3**                                                                                                                                                                                                                                                                                                                                              |
| `MIC_MAX_LEAD = 64`, `micStale` counter                                                                            | **D4**                                                                                                                                                                                                                                                                                                                                              |
| `turn-committed` reports delivered vs arrived                                                                      | **D4** — the instrument was lying                                                                                                                                                                                                                                                                                                                   |
| serialised `ask()` + numbered questions + `#n` cross-check                                                         | **D5**                                                                                                                                                                                                                                                                                                                                              |
| the `#n` label decides the announcement; no label means no number is claimed; `unlabelled`/`mislabelled` published | **D6b** — numbering on top of a shaky correlation is a confident lie                                                                                                                                                                                                                                                                                |
| self-calibrating callId filter, `stray` counter                                                                    | **D6**                                                                                                                                                                                                                                                                                                                                              |
| `sendUpstream(...)` for every provider send; `sendMic` try/catch; `sendFailures` counter                           | a `send` on a closed-but-not-yet-closed socket throws, and these run inside the stream-delivery callback — the same class of accident as D3, reachable whenever the provider socket dies between a redial's dial and its attach                                                                                                                     |
| `MAX_QUEUED_EVENTS = 20_000` on the outbound queue, dropping oldest speaker frames, counted as `droppedSpk`        | **hardening, not an observed defect.** 90s of burst audio (4500 events) delivered fine; but the queue had no ceiling at all, and the failure past one is a Durable Object running out of memory, which ends a call with no event and no reason. ~6 minutes of speech in hand is far past any answer a person sits through, so it should never fire. |
| `call-ended` reason carries `redials, providerJunk, handlerErrors, sendFailures, droppedSpk, stray`                | every counter above is useless if it dies with the isolate                                                                                                                                                                                                                                                                                          |

Deliberately **not** changed:

- **D7** (pre-`response.created` audio attribution) — the fix risks a worse
  defect; see above.
- **The redial ladder's 40-attempt / ~3-minute budget.** With D2 fixed, a call
  that never came up dies at 15s regardless, and 40 attempts is the right
  budget for a _live_ conversation whose provider is flapping.
- **`agent.ask()` itself.** The order-matching is a platform contract with a
  docstring that says so. Fixing it properly means a correlation id on
  `web-message-sent`, which is a platform change, not a userspace one — worth
  raising, out of scope here.
- **The colleague-answer cascade** (each answer arriving as a fresh
  `response.create`, so the model can answer the answer and ask again). Real,
  and 22 asks in 3 seconds is not a healthy shape, but the trigger in my trace
  was a fake with its finger jammed on the tool button. Bounding it needs a
  policy decision (a per-call ask budget? a cooldown?) rather than a patch.

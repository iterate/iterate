---
name: fix-stream
description: Turn a broken agent-stream URL (os.iterate.com/projects/<slug>/agents/streams/agents/<id>) into a red repro test, then a green fix, then a minimal fixture. Use when user says "fix <stream url>", pastes a stream URL with a complaint, or reports an agent chat that went wrong/silent.
publish: false
---

# fix-stream

Given stream URL where agent chat went wrong. Dump events. Judge complaint. Seed real events into unit test. Red test -> PR -> fix -> green -> minimise fixture. Written caveman-style: terse on purpose, all substance kept.

## 1. Dump events

URL `/projects/<slug>/agents/streams/agents/<id>` -> stream path `/agents/<id>`.

Resolve slug -> project id (needs deployment admin):

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli itx run \
  -e 'return (await itx.projects.list({ scope: "deployment" })).filter(p => p.slug === "<slug>")'
```

Dump full journal (getEvents caps at 500 -> page):

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli itx run \
  --context <prj_id> --file dump.ts   # script body below, save in scratchpad
```

```ts
const stream = itx.streams.get("/agents/<id>");
const all = [];
let after = 0;
while (true) {
  const page = await stream.getEvents({ afterOffset: after, limit: 500 });
  all.push(...page);
  if (page.length < 500) break;
  after = page[page.length - 1].offset;
}
return all;
```

Strip pnpm banner from stdout before JSON.parse (find first `[\n`).

## 2. Diagnose

Print conversation: `user-message-received` payload.content vs `web-message-sent` payload.message, with offsets. Find where user visibly lost: silence after input, wrong answer, error leak. Zoom into offsets around bad part — full payloads. Usual smoking gun: `agent/llm-request-completed` with `result.status: "failure"` and no `agent/output-added` after. Complaint = user-level symptom, not mechanism. Write it down before reading product code.

## 3. Repro test — unit lane, not e2e

Real LLM slow/expensive/flaky. Bug almost always deterministic at transport boundary -> unit lane. Model on `apps/os/src/domains/agents/agent-processors.test.ts`: `MemoryStream`, `deliverNewEvents`, fake transports (`fakeResponsesWebSocket` for openai-ws, fake `ai.run` for cloudflare-ai).

Test file: `apps/os/src/domains/agents/stream-repros/<slug>-<id>-<complaint>.test.ts`. Fixture JSON next to it.

**Fixture shrink at dump time** (raw feed can be MBs — 9.9MB seen). Allowed, note each in test file:

- Drop event types no processor under test consumes (`openai-ws/llm-response-chunk` = bulk).
- Strip bulky payload fields no reducer reads (`result.rawResponse` on both `llm-request-completed` types).
- Keep offsets + everything else verbatim. Fidelity first; minimisation is step 6, not now.

**Seed = come into chat halfway.** Push fixture events directly into `stream.events` (keep original offsets). Prime checkpoint = DO-restart semantics: reduced state covers history, side effects only for new events:

```ts
const agent = new AgentProcessor({
  stream,
  readState: async () => ({ offset: lastSeededOffset, state: reduceAgentEvents(seeded) }),
});
const provider = new OpenAiWsProcessor({
  stream, apiKey: "sk-test",
  createResponsesWebSocketClient: async () => fakeSocket, // mimic REAL provider behaviour incl. the failure
  readStreamEvents: () => stream.getEvents(),
  readState: async () => ({ offset: lastSeededOffset, state: { requests: {} } }),
});
```

Fake transport must behave like real provider did: e.g. request carries `input_image` -> reply error frame with real 400 message; else normal `response.output_text.delta` + `response.completed`.

**Append bad event(s)** (verbatim from dump, minus offset/createdAt), deliver processors in loop, `waitForEvent` with short timeout.

**Assertion appropriately broad** — user level, not mechanism: "agent eventually appends `agent/output-added` after the user input". Not "request body lacks input_image" — that's the fix, not the complaint.

## 4. Confirm red, push

`pnpm vitest run <file>` from apps/os — must fail for the diagnosed reason (read the failure!). Commit test+fixture, push, open/update PR (draft) so CI shows red. PR body: before/after event excerpt from prod stream.

## 5. Fix, confirm green, push

Smallest product fix consistent with existing design intent (grep for existing fallback paths first — often gap is routing, not missing machinery). Run test green. Full lane: `pnpm --dir apps/os vitest run src/domains/agents`. Push.

## 6. Maintainability pass — minimise fixture

Preamble events usually irrelevant. Loop:

1. `git stash` the fix (or revert locally) -> test red again. If not red, minimisation broke repro — back up.
2. Cut fixture: keep only events reducers need for bad part to fire (provider-selected, config, last few history entries, the bad input). Re-check red.
3. Restore fix -> green. Push both.

End state: fixture tens of events, not thousands. Test readable top-to-bottom: seed, bad event, broad assertion.

## Gotchas

- `--context` takes `prj_...` id, not slug.
- MemoryStream.append re-assigns offsets = events.length+1 — direct-push seeds to keep real offsets contiguous from 1.
- Idempotency keys in fixture: keep. Replay dedup depends on them.
- Fake provider checkpoint: without readState prime, historical `llm-request-requested` may re-execute (state folded per batch, completion not yet visible). Prime both processors.
- Signed URLs in fixtures expire (7d default) — fine for unit tests (nothing fetches), note if test ever goes e2e.

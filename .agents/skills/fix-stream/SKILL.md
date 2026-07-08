---
name: fix-stream
description: Turn a broken agent-stream URL (os.iterate.com/projects/<slug>/agents/streams/agents/<id>) into a red repro test, then a green fix, then a minimal fixture. Use when user says "fix <stream url>", pastes a stream URL with a complaint, or reports an agent chat that went wrong/silent.
publish: false
---

# fix-stream

Given stream URL where agent chat went wrong. Dump events. Judge complaint. Seed real events into repro test. Red test -> PR -> fix -> green -> minimise fixture.

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
  --context <prj_id> --file dump.ignoreme.ts   # script body below, save in scratchpad
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

Print conversation: `user-message-received` payload.content vs `web-message-sent` payload.message, with offsets. Find where user visibly lost: silence after input, wrong answer, error leak. Zoom into offsets around bad part — full payloads. Complaint = user-level symptom, not mechanism. If there was an API error but the system recovered fine, that's probably not what the complaint is about. Write down the complaint before reading product code.

## 3. Repro test — in-memory, not e2e

Real LLM slow/expensive/flaky. Bug almost always deterministic at transport boundary -> in-memory test: real processors + real reducers, fake transport, no deployment, no real LLM. Harness lives in `apps/os/src/domains/agents/test-helpers.ts`: `MemoryStream`, `deliverNewEvents`, `fakeResponsesWebSocket` (openai-ws). Fake `ai.run` for cloudflare-ai — see `agent-processors.test.ts` for usage of all.

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
  stream,
  apiKey: "sk-test",
  createResponsesWebSocketClient: async () => fakeSocket, // mimic REAL provider behaviour incl. the failure
  readStreamEvents: () => stream.getEvents(),
  readState: async () => ({ offset: lastSeededOffset, state: { requests: {} } }),
});
```

Fake transport must behave like real provider did: e.g. request carries `input_image` -> reply error frame with real 400 message; else normal `response.output_text.delta` + `response.completed`.

**Append bad event(s)** (verbatim from dump, minus offset/createdAt).

**Drive delivery hop-by-hop.** Each event a processor appends only reaches processors on the NEXT `deliverNewEvents` call — one deliver then one long `waitForEvent` = deadlock. Pattern:

```ts
await deliverAll(); // input -> scheduled appended
await stream.waitForEvent({
  afterOffset: bad.offset,
  eventTypes: [".../agent/llm-request-scheduled"],
  timeoutMs: 1_000,
});
await deliverAll(); // agent sees scheduled -> debounce timer -> appends requested
await stream.waitForEvent({
  afterOffset: bad.offset,
  eventTypes: [".../agent/llm-request-requested"],
  timeoutMs: 2_000,
});
await deliverAll(); // provider executes
```

**Assertion appropriately broad** — user level, not mechanism: "agent eventually appends `agent/output-added` after the user input". Not "request body lacks input_image" — that's the fix, not the complaint.

## 4. Confirm red FOR RIGHT REASON, push

`pnpm vitest run <file>` from apps/os. Timeout alone proves nothing — dump what actually happened. Trick: temporary assertion

```ts
expect(
  stream.events
    .filter((e) => e.offset > lastSeededOffset)
    .map((e) => ({ type: e.type, payload: e.payload })),
).toEqual("SHOW ME");
```

Vitest prints full diff. Verify failure chain matches prod (same error message, same event shape). Remove trick line. Commit test+fixture, push, open/update PR (draft) so CI shows red. PR body: before/after event excerpt from prod stream.

## 5. Fix, confirm green, push

Smallest product fix consistent with existing design intent (grep for existing fallback paths first — often gap is routing, not missing machinery). Run test green. Full lane: `pnpm --dir apps/os vitest run src/domains/agents`. Push.

## 6. Maintainability pass — minimise fixture

Preamble events usually irrelevant. Loop:

1. Revert fix locally (`git checkout <red-commit> -- <product-file>`) -> test red again. If not red, minimisation broke repro — back up.
2. Cut fixture. Known-good minimal recipe: `agent/llm-provider-selected` + the last complete turn before bad part (user-message-received through its script-execution-completed) — ends quiescent (currentRequest null, pendingTriggerOffset null). Watch pendingTriggerOffset: seeding an `input-added` with trigger behaviour but WITHOUT its llm-request-scheduled leaves pending trigger armed -> spurious request on first deliver.
3. Commit + push red-minimal state (CI proves minimal fixture repros), restore fix (`git checkout <green-commit> -- <file>`), run green, commit + push.

End state: fixture tens of events, not thousands. Test readable top-to-bottom: seed, bad event, broad assertion.

## Gotchas

- `--context` takes `prj_...` id, not slug.
- Seed by direct `stream.events.push(...)` — keeps real prod offsets. Gaps from dropped bulk events fine: MemoryStream.append assigns last-offset+1.
- Idempotency keys in fixture: keep. Replay dedup depends on them.
- Provider checkpoint: without readState prime, historical `llm-request-requested` may re-execute (state folded per batch, completion not yet visible). Prime both processors.
- Assertion `afterOffset: badEvent.offset` — seeded history may contain matching event types; scope waits past seed.
- Signed URLs in fixtures expire (7d default) — fine here (nothing fetches), note if test ever goes e2e.
- Debounce is 250ms (`DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS`) — waitForEvent timeouts of 1–2s plenty; no sleeps.

# Script reuse: the second factorization should not re-derive the algorithm

This eval exercises `itx.previousScriptAsHelperFunction` (branch
`codemode-script-reuse`), which is NOT deployed to production. Run everything
against the **local dev server in this branch's worktree**, from `apps/os`
inside `doppler run --config dev -- …`:

1. `doppler run --config dev -- pnpm dev status` — if not running (or
   unhealthy), `doppler run --config dev -- pnpm dev restart --detach`.
2. Create a fresh project on that dev server (default template), then an
   agent, and drive it with `agent.ask` through the itx surface
   (`doppler run --config dev -- pnpm cli itx run …`).

Send the agent two chat turns, the second only after the first has fully
settled:

> prime factorize 52479543428582704627

then

> now do 66778601389380731119

(52479543428582704627 = 6203868971 × 8459163737;
66778601389380731119 = 7316102869 × 9127619251. Both are semiprimes of
10-digit primes — trial division cannot finish, so the first turn forces a
real algorithm (Pollard's rho or similar) and a long script. Verify the
agent's answers with your own arithmetic, not by trusting its prose.)

The system prompt teaches the agent that a repeat-shaped request should reuse
the journaled script: `itx.capabilityHost.previousScriptHelper({ eventOffset,
parameters: { n: <original inline value> } })` locates each value's literal in
the earlier script and returns a handle whose typed `run(vars)` re-executes it
with new inputs as a journaled child run. Void scripts leave a `done` row in
`results`, so `results[N].offset` is the handle even when turn 1's script
returned nothing.

Success criteria — the mechanism matters as much as the answers:

- Both factorizations are correct in the agent's chat replies. (Turn 2's
  first message may carry the OLD number in its prose if turn 1's script
  hardcoded it in its sendMessage template — a follow-up correction message
  with the right equation for 66778601389380731119 still counts as success,
  and is worth reporting.)
- Turn 2 includes an agent-authored script calling
  `itx.capabilityHost.previousScriptHelper` pointed at turn 1's run, and no
  agent-authored script in turn 2 re-derives the factorization algorithm
  (no second Pollard's-rho/trial-division implementation written by the
  agent; the journaled CHILD run the platform synthesizes contains the
  original algorithm — that one is platform output and is expected).
- Turn 2's agent-authored scripts are dramatically shorter than turn 1's —
  report character counts from the
  `events.iterate.com/capability-host/script-run-requested` events on the
  agent's stream, distinguishing agent-authored runs (executionId
  `agent-output:<offset>`) from the platform's child run (UUID executionId).
- A couple of corrective retries are tolerable (e.g. a rejected parameter
  name); the reuse path should succeed within turn 2.

If the agent never reaches for `previousScriptHelper` (it rewrites
the algorithm, or pastes the old script text into a new script), that is a
**failure** — the feature's value is that the teach plus the API is enough
for the model to discover and use it.

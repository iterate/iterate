---
status: needs-grilling
size: medium
---

# LLM attempt stall detection

An LLM attempt that dies mid-stream is never settled on its own. The request stays open until something else is delivered to the stream, so the agent's reply never arrives and the next user message queues behind the dead attempt.

## Live observation

preview-15, stream `/agents/onboarding`, 2026-08-21, two runs (15:08 and 15:11 UTC): request recorded → 19 `agent/llm-response-chunk` events over ~1.3s → silence. No `agent/llm-request-settled`, no failure, still open 12+ minutes later, past the 10-minute `llmRequestExpiryMs` horizon. The expiry settle in the turn loop only runs when a delivery wakes the stream; with nothing delivered, nothing ran. Same family as the 2026-08-13 prd incident noted in `agent-turn-loop.ts`.

What the harness shows (`apps/os/src/domains/agents/agent-llm-stall.test.ts`, expected-fail): with the scripted transport never resolving and ignoring abort, nothing settles at 60s, 9m, 10m+1s, or 10m30s of virtual time. The first self-driven wake is the keepalive's wedge detection (`MAX_CONSECUTIVE_BUSY_REFIRES` = 90 busy refires at a 10s lead, ~15 min), whose revival fact is the delivery that triggers the expiry settle. So the effective bound today is ~15 min after dial, not 10, and it exists only because of the keepalive's crash-loop breaker.

Options, one sentence: a chunk-idle watchdog on the attempt (abort + settle failed when no chunk arrives for N seconds), or alarm-driven expiry instead of delivery-driven.

- [ ] decide the stall budget and make the spec pass (`apps/os/src/domains/agents/agent-llm-stall.test.ts`, currently `it.fails` with a 60s bound)

---
status: needs-grilling
size: medium
---

# Nudge agents whose turn ends silently

Placeholder for a future grilling, not a spec.

## The idea

Detect "agent turn ended with no sendMessage (and no return value?)" and give
the model one opportunity to rectify — something like: "your turn ended with
nothing visible to anyone; here's an opportunity to fix that, unless you
think silence was appropriate."

## Motivating incident

Prod project `misha`, thread `mobile/2026-08-01t03-30-40-828z`: a script
awaited a Gmail GET held at the egress door, received the released 200 after
the human approved, discarded it, and returned undefined — silent settle by
contract. The user approved and saw nothing; the agent's next turn had no
idea the approval had landed. The first attempted fix (relaying approval
decisions into the thread) was dropped: held fetches must stay opaque to
scripts, and the real gap is this more general silent-turn shape.

## Needs thinking through

- Channels differ: web chat is `itx.chat.sendMessage`, Slack/Telegram/email
  replies go through their own APIs — "no sendMessage" is not one signal.
- Some turns legitimately end silent (background maintenance, a summary-only
  update, mid-delegation waits). The nudge must not train agents to emit
  noise.
- Where does detection live — the agent processor's settle handling, the
  render lane, somewhere else? What counts as "visible output"?
- One nudge max per turn; a nudged turn that stays silent should stand.

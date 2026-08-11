---
status: in-progress
size: medium
branch: waiter-chef
---

# Waiter/Chef: front-of-house / back-of-house agent pair as a config template

## Status summary

Spec fleshed out, implementation not started. Pure userland: a new
`configs/waiter-chef/` template, zero platform changes. Built on the merged
birth-defaults surface (#2423 + #2474). The eval is human/feel-based — Misha
drives testing; expect knob-tweaking commits.

## The idea (from Misha, lightly organized)

Restaurant metaphor. The user talks to the **Waiter**: fast, plain-English,
knows the *Menu* (what the system can do) but not the technical how. The
**Chef** is the existing full-fat platform agent: tools, codemode, opinions.
The waiter relays orders to the kitchen, gives status updates, and can "look
over the chef's shoulder". Motivation: voice models are fast, bad at tools,
not very smart — perfect waiters. Test with text chat first; voice later.

Requirements called out:

- Don't invent an unnecessary layer — the chef *does*, the waiter *talks*.
- Waiter always responds fast; avoids saying untrue things; corrects itself
  when it inevitably does.
- Waiter judges whether to interrupt a busy chef.
- Two LLM lanes running in parallel is expected and good.

## Design

Everything lives in a config template; the platform event vocabulary is
already sufficient.

### Cast

- **Waiter** = every web chat agent (`/agents/web/<slug>`). Project birth
  defaults (`matches: {pathPrefix: "/agents/web/"}`) make it born with:
  - `agent/configured`: `driver: "agent-headless"` (no tools, no codemode —
    one fast LLM call per turn), waiter model knob, low debounce.
  - waiter system prompt slot (`prompts/waiter-system-prompt.md`).
  - `agent-headless` facet subscription (already allowlisted for birth
    defaults).
- **Chef** = `/agents/chef/<slug>` (same slug as its waiter). Created lazily
  by the config worker on the first kitchen order, via the same generic door —
  the path prefix doesn't match, so it's a stock platform agent (classic
  driver, default prompt, all tools). The worker appends a keyed briefing
  context (`prompts/chef-briefing.md`): you're back-of-house, messages come
  from the waiter relaying a diner, report succinctly when done/blocked, your
  chat is mostly unwatched but the diner may peek.

### Protocol (worker.ts interprets waiter output, codemode-tag style)

Waiter responses are plain prose plus optional tags, parsed by
`waiter-format.ts`:

- prose → `agents/web-message-sent` (what the user sees; llmRequestOffset so
  the mirror skips it).
- `<kitchen>…</kitchen>` → ensure chef exists, then `agents.get(chefPath)
  .message("From the waiter, relaying the diner: …")` — worker-scope itx
  stamps it a user message, so the chef's turn budget refills like a real
  user asked.
- `<peek/>` → worker snapshots the chef processor (busy/idle, current
  activity, last assistant message) and appends it to the waiter as developer
  context with `after-current-request` — the waiter's next turn relays it in
  its own words.

Chef → waiter: every `agents/web-message-sent` on `/agents/chef/**` is
relayed to the paired waiter as developer context ("The chef says: …",
`after-current-request`) — the waiter decides what to tell the user. The chef
prompt teaches it to send a concise chat message when done or blocked, which
is just its natural final response.

The waiter's Menu: `MENU.md` in the config repo, synced to waiter agents as
keyed standing context (same recipe as the AGENTS.md sync). Editing the menu,
the prompts, or the parser is a git commit — no deploy.

### Template contents

Fork of `configs/default` (keeps docs app, AGENTS.md sync, onboarding) plus:

- `MENU.md` — plain-English capabilities list for the waiter
- `prompts/waiter-system-prompt.md` — character + tag grammar + honesty rules
- `prompts/chef-briefing.md` — kitchen protocol briefing
- `waiter-format.ts` — tag parser (attribution: inspired by
  `configs/codemode-tag/codemode-format.ts`)
- `worker.ts` — default worker + birth-defaults publish + waiter interpreter
  + chef relay

### Checklist

- [ ] `configs/waiter-chef/` template: forked base files, MENU.md, prompts,
      parser, worker
- [ ] waiter-format parser unit test (vitest, colocated in the template like
      codemode-format's)
- [ ] Prompt-file formatter exemption (`.oxfmtrc.json` ignorePatterns —
      `configs/waiter-chef/prompts/`)
- [ ] Live smoke on a preview or dev: create project from
      `github:iterate/iterate#waiter-chef&path:configs/waiter-chef`, run the
      starter prompts below, iterate with Misha
- [ ] Knobs surfaced for the feel-eval: waiter model, debounce, relay
      trigger behavior

## Assumptions made (Misha AFK-style delineation)

1. **Waiter = all web chats** in an opted-in project, rather than a specially
   named agent. Cleanest mapping to the UI (every new chat is a table).
2. **Chef is bone-stock** — no custom system prompt, just a briefing context
   item. Keeps "the chef is the existing genius" literal, and dodges the
   single-birth-defaults-slot limitation entirely.
3. **Chef listens via the waiter only** (v1). Misha floated "chef listens
   directly to the user, at least while idle" — deferred; the relay message
   carries the diner's words near-verbatim, so little is lost, and it keeps
   the lanes legible. Easy follow-up if relaying feels laggy.
4. **Waiter model starts as the platform default** (`openai/gpt-5.6-terra`)
   with the knob at the top of worker.ts. Rationale: reasoning effort is
   pinned "medium" for the whole gpt-5 family in the transport, so a smaller
   gpt-5 won't obviously be snappier; the interesting experiments (partner
   non-reasoning models via `itx.ai.models()`) are exactly the live tweaking
   this eval is for.
5. **Peek is a tag, not automatic** — the waiter chooses when to look. Plus
   the automatic chef-message relay for push-style updates.
6. **Interrupt judgment lives in the waiter prompt**, not mechanism: it's
   told the chef's busy-state (via peek results and relay timing) and decides
   whether to `<kitchen>` immediately or hold. The chef processor already
   queues mid-turn messages safely either way.

## Starter prompts for the feel-eval

1. *(Misha's)* "Make me a webpage for a multiplayer turn-based Subbuteo-like
   game involving 'flicking' characters towards a ball to try to score a
   goal." — long build; exercises status updates + progress link.
2. "What's on the menu — what kind of things can you do for me here?" —
   waiter must answer alone from MENU.md, never bothering the kitchen.
3. "Find the GitHub repos this project can see and make me a page ranking
   them by recent commit activity." — tools + integrations; medium duration.
4. *(while #1 or #3 is cooking)* "Actually, make the ball hot pink." —
   interrupt judgment on a busy chef.
5. "Plan a 3-day Lisbon itinerary, then email it to me." — external side
   effect; tests the waiter confirming before the kitchen fires an email.
6. *(immediately after an order)* "Is it ready yet?" — honest fast status via
   peek, no fabrication.

## Implementation log

- (2026-08-11) Spec committed first per worktreeify convention. Research
  confirmed: `agents.get(path).create()` hits the generic door (defaults fold
  in), worker-scope `message()` stamps user actor, web chats born at
  `/agents/web/<iso-slug>`, onboarding at `/agents/onboarding` unaffected by
  the `/agents/web/` prefix.

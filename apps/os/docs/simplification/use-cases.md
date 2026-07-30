# Use cases — startup / co-worker / family butler (concrete)

> **DRAFT — Claude's guess at how each looks concretely, grounded in the `DESIGN.md` model
> (two entry points HTTP+alarm; streams; agents = presets of events; `processEvent`; egress
> wall; `provideCapability`; scheduler; the membrane). Awaiting Jonas's corrections — we
> jam and add meat to the bones.** Companion to `DESIGN.md` / `core-model-grounding.md`.

## ★ Ideas to actually try (Jonas)

- **The multiplayer self-rewriting game** — Jonas, 2026-07-15: _"I love this so much… this is an
  idea that we can try."_ A game lots of people play together AS an organism: world = a shared
  stream, each player + each NPC = an agent (any channel; every visitor is an agent conversation,
  [[DESIGN:R19]]), real-time on the ephemeral lanes ([[DESIGN:D11]]). **The magic: the world's RULES
  are code a Game-Master agent rewrites as people play** — players _program the world through
  behaviour_; rule-changes go through protected-`main` so bad rules roll back; the world is
  replayable/forkable. **Why it's so good (Jonas riffing):** it can serve **different web
  interfaces**, the GM can **invent things** (items / quests / mechanics / even new UIs, as
  generated code), and the GM can **charge players real money to play** (egress + spend membrane)
  → a **self-funding game** that pays its own compute bills and could reinvest to grow. Flavors:
  Prayer-Engine / Constitution / Escape-room-that-fights-back. **Saved to memory.** → keep jamming.

## 1. The startup — a whole company as one organism ("Acme")

**Shape.** One project. `worker.ts` `fetch` serves the marketing site + the product app
(hostname-routed). Streams are the org: `/agents/support`, `/agents/eng`, `/agents/growth`
(each an agent = a preset of events), `/repos/config` (its own DNA), `/repos/product` (the
product code), an `/inbox` for customer email, a `/slack` mirror, a `/metrics` stream.

**A day (one causal chain):**

1. Customer emails `support@acme.com` → email webhook (HTTP entry point) → `append` to `/inbox`.
2. `processEvent` routes it: cross-post onto `/agents/support`; the support agent (already
   "alive" = its preset of events) wakes.
3. It searches the knowledge base (a provided capability), decides it's a bug → **cross-posts to
   `/agents/eng`**, pings the founder on Slack (egress), and emails the customer "on it" (egress).
4. Eng agent opens `itx.repos.get("/repos/product")`, edits code, `commitFiles` to a branch → a
   **PR agent** (one per PR) is born; founder reviews; merge to protected `main` (the promotion gate).
5. Scheduler: a 9am `{ cron }` fires → append → the growth agent writes the daily metrics report
   → posts to Slack.
   **Distinctive:** "hiring" = spawn an agent (append a preset of events); the org chart = the tree
   of agent streams; the company **rewrites its own product AND its own config** as it runs.
   **Stresses:** the self-improvement loop, the promotion gate (D19/D14), many concurrent agents.

## 2. The co-worker — one AI teammate inside a human team ("Dana")

**Shape.** Does NOT own the company's systems. It's a single entity (one main agent, maybe a
few helpers) that lives _in the humans' existing tools_ — reachable exactly like a colleague:
`@Dana` in Slack, email `dana@`, assign it a GitHub issue/PR, or talk to it over MCP / voice.
It holds **capabilities into the team's tools** (their Slack, GitHub, BigQuery) via
`provideCapability` + allowlisted secrets — BYO integrations.

**A moment:** `@Dana pull the Q3 numbers and draft the board update` → Slack event → append →
the agent uses a mounted BigQuery capability (secret-substituted at egress) → drafts in a Google
Doc (egress) → posts the link back. It keeps its own memory (its stream), schedules its own
follow-ups (`scheduler`: "nudge me Friday"), writes small automations but mostly _operates
existing tools_.
**Open design question I can't resolve:** is Dana a **separate project** that talks to the
company's project ("let my iterate talk to your iterate"), or an **agent inside** the company's
project? Both are expressible; they differ on trust boundary.
**Stresses:** the graded edge (Dana treats humans as outside stakeholders), BYO capabilities.

## 3. The family butler — a household organism ("Jeeves")

**Shape.** One project. **Multiple humans inside it, all fully trusted** (D1's own example:
"partners in a marriage… all have all the information"). Channels: a family Telegram/WhatsApp,
email, **voice** (a HomePod-style agent), the shared calendar.

**A day:**

- 7am `scheduler` alarm → briefing agent reads the calendar (capability), weather (egress),
  overnight mail → speaks a family briefing (voice) + posts to the family chat.
- "Jeeves, book a table for four Friday at the Italian place" (voice → transcript event → agent →
  egress to a booking API, or **use-my-computer** to actually click it → confirms).
- Recurring: pays bills (egress + secret, **gated by cryptographic human-approval for large
  amounts** — the membrane), keeps the grocery list (a stream), manages the kids' schedule.
- It holds **virtual payment cards with spend limits** (the spend membrane / R14).
  **Distinctive:** the humans are inside (trusted); merchants/schools/banks are outside (graded —
  what do we reveal, are we being tricked). Money moves need the human-approval leg of the membrane.
  **Stresses:** the MOST aspirational layers — spend caps + kill-switch (D14 leg 2, unbuilt),
  crypto human-approval (built), voice/PCM (unbuilt), the graded edge.

## 4. The tutor — a learning organism (one learner, a group of children, or an adult)

**Shape.** One project per learner (or per group). The learner's **stream IS their entire learning
history** — every question, mistake, and "aha", what they struggled with, what they mastered.
Reachable however fits: **voice** (natural for kids), chat, or an interface it **invents** per
learner (dino-themed maths for the dinosaur kid).
**Uniquely iterate about it:**

- **Perfect, permanent, personal memory** — it knows you across _years_, not per-session; it never
  forgets you confused mitosis and meiosis last March.
- **Spaced repetition via the scheduler** — it _schedules the moment you're about to forget_ and
  drills exactly then (the alarm entry point). A tutor that wakes _itself_ to teach you.
- **Self-improving pedagogy** — it rewrites its own teaching code based on what works for _this_
  learner (its curriculum is code it edits) — a tutor that evolves how it teaches _you_.
- **Invents tailored content** infinitely (exercises in your world / at your level), like the game.
- **Real stakes:** grades uploaded work (files / toMarkdown), emails parents, orders materials or
  books a museum trip (egress + membrane).
  **The sharp fork (a group of children):** does [[DESIGN:D1]]'s "everyone inside sees everything"
  break? A kid shouldn't see another kid's grades; a parent should see their child's; the child maybe
  shouldn't see the tutor's private notes on them. So either (a) **each learner is their OWN project**
  and the tutor coordinates _across_ projects (my-iterate ↔ your-iterate), or (b) **a project DOES
  need interior gradation** — the case that stresses D1 hardest. (Same tension as kids-≠-parents in the butler.)
  **Crossover:** the tutor could _be_ the game — learning-as-play, the self-rewriting world as the curriculum.

## Corrections (Jonas, 2026-07-15)

- **`worker.ts` is a proxy/router, not one `fetch`.** Like a normal Workers architecture, the
  config repo can export **several entrypoints** — a stateless worker entrypoint _plus_ internal
  tools hosted from a **Durable Object** exported from the same entrypoint / config repo. The
  marketing site can be a **separate entrypoint** of the config repo, or a **different repo
  altogether** — doesn't matter, as long as **`worker.ts` in the config repo proxies to it**.
- **No load-bearing distinction between the three.** Startup / co-worker / butler are the **same
  organism** — same machinery, differing only in config, channels, and prompts. (Sketches OK.)
- **NEW REQUIREMENT (loud) → [[DESIGN:R19]]: the entire product can BE an agent.** Every visitor
  starts an agent conversation; no difference between internal and external agents.
- **Next:** go berserk — wild, unexpected use cases (codex sub-agent + Claude's own) → collected
  in `crazytown-use-cases.md`.

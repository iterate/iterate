# waiter-chef project configuration

Front-of-house / back-of-house agent service, implemented entirely in this
repo. The user (the diner) talks to a **waiter**: fast, plain-English, no
tools, knows the menu. The **chef** — a bone-stock platform agent with all
its tools — cooks in a paired chat the diner can also open and watch.

```
diner ──chat── waiter (/agents/web/<slug>, headless, fast)
                 │  <kitchen>…</kitchen> orders,  <peek/> glances
                 ▼
               chef (/agents/chef/<slug>, stock platform agent)
                 │  chat messages, relayed back as kitchen notes
                 ▼
               waiter tells the diner, in its own words
```

Why: voice models are fast, bad at tool-calling, and not very smart — ideal
waiters. This template proves the shape with text first.

## How it works

1. On every config deploy, `worker.ts` publishes **agent birth defaults**
   scoped to `pathPrefix: "/agents/web/"` — so every new web chat is born a
   waiter: headless driver (one LLM call per turn, no tools), the waiter
   prompt, and the fast-lane knobs at the top of `worker.ts`.
2. The waiter's responses are prose plus tags (`waiter-format.ts` parses):
   prose goes to the diner; `<kitchen>…</kitchen>` orders are relayed to the
   chef as user messages; `<peek/>` answers from a snapshot of the chef's
   processor state (busy/idle, activity, last words) without disturbing it.
3. The chef is created lazily on the first order — through the same generic
   door, but outside the birth-defaults prefix, so it's stock: default
   prompt, classic driver, every tool. A kitchen-briefing context item
   teaches it the protocol: work normally, send short chat messages at
   moments that matter; the worker relays each one back to the waiter as a
   developer note, and the waiter decides what the diner hears.

Everything is public stream events any project member could append; no
platform privileges. **Iterating on the feel — prompts, menu, grammar, model
knobs — is a commit to this repo. No platform deploy.**

## Trying it

Create a project from:

```text
github:iterate/iterate#waiter-chef&path:configs/waiter-chef
```

Good first orders: "Make me a webpage for a multiplayer turn-based
Subbuteo-like game", then — while it cooks — "Is it ready yet?" and
"Actually, make the ball hot pink."

## Files

- `prompts/waiter-system-prompt.md` — the waiter: character, tag grammar,
  honesty rules, interruption judgement
- `prompts/chef-briefing.md` — the kitchen protocol (standing context; the
  chef keeps the stock platform prompt)
- `MENU.md` — plain-English capabilities the waiter may answer from
- `waiter-format.ts` — the tag parser
- `worker.ts` — birth defaults, the interpreter, both relay lanes, knobs

## Known limits

- Delivery to the config worker is observation-grade: an event the handler
  fails on is skipped, not retried forever — a dropped delivery can lose one
  relay (a new message starts fresh).
- Only NEW web chats become waiters; chats from before the template switch
  keep their existing character.
- Slash commands are platform interpretation and are inert in waiter chats.
- Slack/telegram/email agents and the onboarding agent are untouched.

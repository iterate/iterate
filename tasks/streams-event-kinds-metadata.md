---
state: backlog
priority: low
size: small
dependsOn: []
---

# Streams: event "kinds" metadata in processor contracts (idea, deferred)

Background: the agents-system audit (June 2026); the presence-fact unification
shipped in https://github.com/iterate/iterate/pull/1460.
Explicitly deferred — parked here so it isn't lost.

## Idea

Three kinds of events fall out of the audit's unification:

1. **Configuration facts** — desired state: `subscription-configured`,
   `system-prompt-updated`, `llm-config-updated`, `tool-provider-registered`,
   jsonata rules. Reducers fold these into "what should be true".
2. **Presence facts** — incarnation observations: created/woken/connected.
   Never change desired state; signal "somebody's runtime state reset".
3. **Domain facts** — messages, requests, outputs; the actual conversation.

Proposal: the machine-readable kind lives in **contract metadata** (each event
declaration gets `kind: "config" | "presence" | "fact"`), NOT in the event
type string — renaming types would mean migrating every existing string for
information the contract can carry. Keep the existing naming grammar as a
human convention (`-configured`/`-updated` = config, `woken`/`connected` =
presence, `-added`/`-requested`/`-completed` = domain).

## What it would buy

- `processor-registered`/connect announcements carry kinds → the stream viewer
  can filter by kind ("show me only domain facts").
- The framework can key behavior off declared kind instead of string-matching:
  presence facts auto-union into delivery filters and trigger reconciliation;
  config facts are what agent-visible docs/UI surface.

## Why deferred

The homogenization work (shipped in PR #1460) didn't need it — presence types
are unioned into delivery filters by a hardcoded list. Do kinds once there are ≥2 concrete consumers of the
metadata (viewer filtering + framework routing).

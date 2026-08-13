---
status: in-progress
size: medium
branch: generic-project-defaults
---

# Generic `project/defaults-configured` (de-agent the project processor)

## Status summary

POC in progress. Spec fleshed out, implementation not started.

## Motivation

Jonas's review of `project/agent-birth-defaults-configured`: **a project
shouldn't know what an agent is.** Today the project processor contract
imports `AgentBirthDefaults` from the agents domain, declares an agent-named
event, and validates against the agent-consumed vocabulary at fold time
([project-processor-contract.ts:31,228,297](../apps/os/src/domains/projects/project-processor-contract.ts)).

The project is the right *scope* for "what are agents in this project born
as" — the leak is that the project *contract* spells out the answer's
internals. Fix: demote the project to a generic latest-wins-per-key fact
store; move all interpretation to the consuming domain's read site.

## Design

- New event `events.iterate.com/project/defaults-configured`, payload
  `{ key: string, value: unknown }`. Latest occurrence wins **per key**.
- Project state slot `defaults: Record<string, unknown>` (replaces
  `agentBirthDefaults`). The fold stores the raw value — zero domain
  knowledge, no validation.
- The agents domain owns the key constant
  (`AGENT_BIRTH_DEFAULTS_KEY = "agents/birth-defaults"`), the
  `AgentBirthDefaults` schema, and validation — which moves entirely to the
  creation door's read helper (`agentBirthDefaultsForProject` in
  rpc-targets.ts). Malformed/absent/non-matching → platform-default births,
  same degrade posture as today, warning fires at the door instead of the
  fold. Note the allowlist check (builtin facet-processor subscriptions
  only) is a *platform security* gate and belongs at the door regardless.
- "Never stale" survives: the raw latest value replaces the previous raw
  value per key; a malformed latest validates to "no defaults", not to the
  previous defaults.
- Legacy shim: keep consuming
  `events.iterate.com/project/agent-birth-defaults-configured` (loose
  `Record<string, unknown>` payload schema, no agent imports) and fold it
  into `defaults["agents/birth-defaults"]`. Existing projects' config repos
  drift independently and still publish the old type; without the shim their
  birth defaults silently stop working. Clearly marked for removal once
  deployed config repos have migrated.
- Publishers (`configs/default/worker.ts`, `configs/codemode-tag/worker.ts`)
  publish the new event with a **new idempotency-key prefix** (same key +
  different body is rejected by the stream, so reusing the old prefix would
  wedge republication).

## Checklist

- [ ] Project contract: replace the agent-named event + `agentBirthDefaults`
      slot with `project/defaults-configured` + generic `defaults` record;
      drop the `AgentBirthDefaults` import; add legacy-event shim
- [ ] Project implementation: generic per-key fold (no validation), legacy
      case folds to the agents key
- [ ] agent-defaults.ts: export `AGENT_BIRTH_DEFAULTS_KEY`; keep
      schema/validation as-is
- [ ] rpc-targets.ts `agentBirthDefaultsForProject`: read
      `state.defaults[AGENT_BIRTH_DEFAULTS_KEY]`, `safeParse` +
      `validateAgentBirthEvents` at the door, degrade-to-none on any failure
- [ ] configs/default + configs/codemode-tag workers: publish the new event
      shape (new idempotency-key prefix)
- [ ] Regenerate config-repo-template.generated.ts and itx api generated
      files (`pnpm lint:fix` / codegen scripts)
- [ ] Tests: project-processor.test.ts (generic fold + legacy shim),
      config-repo-template.test.ts (new published shape), agent-defaults
      birth-list tests should pass unmodified; add a door-level test that a
      malformed stored value degrades to platform defaults
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Assumptions (made while Misha is AFK-ish; flag on review)

- Event/key naming: `project/defaults-configured` and key
  `"agents/birth-defaults"`. Easy to bikeshed later.
- The legacy shim is worth its 10 lines (deployed prd/preview projects exist
  since #2474 merged 2026-08-11). If you'd rather break them, delete the
  shim commit.
- `matches.pathPrefix` stays inside the agents-owned value, not lifted into
  the generic envelope — scoping semantics are the consumer's business.
- No per-key event vocabulary registry: any key can be published; only keys
  a consumer reads mean anything. Unknown keys are inert data.

## Implementation log

(append as work happens)

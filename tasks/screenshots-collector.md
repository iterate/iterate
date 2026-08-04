---
state: ready
priority: medium
size: large
tags: [mobile, files, processors, ai]
---

# Screenshots collector

**Status summary:** specced via grill-you interview ([transcript](screenshots-collector.interview.md)), not started. Every design branch resolved; guesses flagged below. M1 is a thin vertical slice: permission → foreground sync → one rule → OCR → LLM → queryable result.

The mobile app gains full photo-library access, syncs photos into a project's file storage, and a per-project rules pipeline processes each photo cheap-first: free on-device metadata → OCR via `itx.ai.run` (screenshots only) → LLM instruction only for photos whose rule matched. Rules are user-configured, e.g. "screenshot of an X post → find the post URL, capture the text, categorise as 'interesting tech articles'".

## Design decisions (from the interview)

**Sync pass** is the unit of work: diff library → upload deltas → append one batch event. Trigger-agnostic by contract; foreground-open and a manual "sync now" button are the only *contracted* triggers. `BGAppRefreshTask` (expo-background-fetch + expo-task-manager) is a contract-free opportunistic accelerant — nothing durable may depend on it firing — and ships only after an on-device prototype (see checklist). Silent-push-triggered sync is a named future lever, not designed here.

**Backfill** is a separate explicit job: newest-first, throttled, resumable, with a simple max-N-per-pass safety cap. Forward sync starts at grant time; backfill is user-triggered.

**Permissions**: iOS presents a three-way prompt (Full / Limited "Select Photos" / Deny), surfaced by `expo-media-library` as `accessPrivileges: 'all' | 'limited' | 'none'`, and users can downgrade later in Settings. Degrade gracefully — a sync pass doesn't care how big the visible library is; show a soft "Limited access" banner, never a blocking screen.

**Ingestion** mirrors email ingress (`apps/os/src/domains/email/email-ingress.ts`), not `agent.addFiles`: bytes go directly to `itx.files` at `/photos/inbound/<stableKey>-<filename>`, then one project-level `photos-synced` event per sync-pass batch carries an array of per-asset records (stored path, stableKey, metadata). No agent feed involved — coupling a 14k-photo backfill to agent compaction semantics would be a design smell. Verified: `itx.files.get(path).put()` and `itx.streams.get(path).append()` are both callable from the mobile capnweb stub over the existing socket; zero new server seam.

**Dedup**: stable key = iOS asset `localIdentifier` + content hash, never random (email-ingress `messageKey` doctrine). The client keeps a local synced-cursor as *disposable cache*; the collector processor's DO-SQLite reduction of `photos-synced` events is the durable source of truth, exposed as `alreadySynced(stableKeys[]) -> stableKeys[]` on the collector capability surface. Wiping the local cursor and reconciling from the server must always be safe (reinstall, second device).

**Metadata**: `expo-image-picker`-style recompression strips EXIF, so capture `mediaSubtypes` (iOS natively tags screenshots — free `isScreenshot`), `creationTime`, and dimensions on-device *before* recompression and carry them in the per-asset event records. The server never infers screenshot-ness.

**Rules** follow the egress-rules precedent (`project-processor-contract.ts` `egress-rules-configured`): ordered list, `ruleKey`, `description`, wholesale replacement in one `photos-rules-configured` event, first-match-wins. `match` is structured and cheap (`isScreenshot`, `ocrKeywords`, dimensions, …). The *action* is a free-text instruction string handed to the LLM step when a photo matches. The LLM returns a structured result envelope — `category`, `extractedUrl`, `extractedText`, `notes` — the instruction controls the content, not the shape. Configured via itx script (like egress rules — no settings UI for MVP).

**Pipeline layers** (cheap-first):
- Layer 0 — on-device metadata, free. Non-screenshots short-circuit here for content rules.
- Layer 1 — one shared OCR pass per screenshot via `itx.ai.run` with a cheap model, cached per asset, feeding match evaluation for every rule.
- Layer 2 — LLM instruction, only for photos whose rule matched. Follows the obligation pattern (`…-requested` with expiry → `…-settled` with result union).

**Outputs**: terminal per-photo processed event folded into the same processor state; queryable via `listByCategory(category)` / `getResult(stableKey)` plus signed-URL access on the collector capability. The MVP read surface is itx scripts — "this week's interesting-tech-articles with links" must be a three-line script.

**Ownership**: explicit per-device, per-project opt-in toggle (device-local state); a device may feed multiple projects, each deliberately enabled. This answers the location-reminders trap head-on: photo sync is *device-initiated push* — the device the user toggled decides to run a sync pass — not the project reacting to an ambiguous set of candidate devices, so there is no first-phone race to arbitrate.

## Checklist

### M1 — vertical slice (the product, small)

- [ ] Add `expo-media-library`; permission flow with graceful Limited-Access degrade + soft banner (new native module ⇒ new EAS dev-client build)
- [ ] Sync-pass engine: enumerate assets, compute stable keys, reconcile via local cursor + `alreadySynced`, upload deltas to `itx.files`, append one `photos-synced` batch event with per-asset metadata records (captured pre-recompression)
- [ ] Per-project "collect photos into this project" toggle + manual "sync now" (foreground-open trigger too); device-local toggle state
- [ ] Collector processor (contract/implementation split per doctrine): reduce `photos-synced` into synced-state; expose `alreadySynced`
- [ ] `photos-rules-configured` event + rule schema (egress-shaped; structured match, instruction action)
- [ ] Layer 1: shared OCR pass via `itx.ai.run` gated on `isScreenshot`, cached per asset
- [ ] Layer 2: LLM instruction step as an obligation (`…-requested`/`…-settled`), structured result envelope
- [ ] Read surface: `listByCategory` / `getResult` / signed-URL on the collector capability
- [ ] Spec/e2e fixture rule: "any screenshot → category `uncategorized` + extractedText" proving the spine end-to-end
- [ ] Dogfood acceptance demo: configure the X-post rule (pure config — match + instruction; URL recovery may lean on `itx.mcp.exa` from handle+text; imperfect is fine). If it needs *any* code beyond config, treat that as a rule-model design bug

### M2 — backfill

- [ ] Explicit "import existing library" job: newest-first, throttled, resumable across app restarts, max-N-per-pass cap, visible progress

### M3 — background refresh (prototype-gated)

- [ ] Prototype `BGAppRefreshTask` behavior on-device across lock, reboot, force-quit, low-power *before* wiring it to sync (location-reminders lesson)
- [ ] If the prototype earns it: register the task as a contract-free trigger of the same sync pass

## Guesses and assumptions

- [guess] BGAppRefreshTask is in scope (M3) rather than deferred entirely — "at whatever cadence is possible" was explicit in the original ask.
- [guess] Newest-first backfill ordering — recent screenshots are the valuable ones.
- [guess] First-match-wins rule semantics (over all-matching) — simpler, mirrors egress; revisit if one photo should land in two categories.
- [guess] Device-local toggle state rather than a server-side device registry entry — the device is the actor; server state adds a reconciliation problem for zero benefit.

## Out of scope

- Android; Expo Go restoration.
- Agent-turn vision content parts (transport is text-only today; vision goes through `ai.run`).
- Settings UI for rules (itx-script configured, like egress rules).
- Billing/quotas beyond the max-N safety cap.
- Silent-push-triggered sync (future lever, uses existing device/notification stack).

## For the next pass

- Typecheck-validated user rule *scripts* (`itx.docs.typecheck`) as a power-user escape hatch beyond instruction strings.
- Per-category markdown digest files; a gallery/screenshots lens as a natural fifth lens in `tasks/workspace-lenses-consolidation.md`.
- Dynamic per-rule-set OCR gating (only run OCR if a live rule still needs content signal).
- Multi-category (all-matching) rule semantics if wanted.

## Notes

- High-volume stream delivery is a known weak point (`tasks/redesign-high-volume-stream-delivery-transport.md`); batch events per sync pass (not per photo) is deliberate mitigation. A 20k backfill will still exercise it — keep the cap conservative at first.
- Interview transcript: [screenshots-collector.interview.md](screenshots-collector.interview.md)

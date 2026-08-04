# Interview: screenshots-collector

Grilling session: sub-claude runs grill-with-docs against the dossier at /tmp/grillings/iterate/screenshots-collector/dossier.md; the orchestrating agent answers on Misha's behalf. Guesses tagged `[guess: ...]`.

---
## Q1 — what does "background" mean for capture? — 2026-08-04
Options: (a) foreground-triggered sync only; (b) BGAppRefreshTask best-effort; (c) both, (a) as contract + (b) contract-free. Sub-claude recommended (a) only for MVP.

## A1
(c), leaning harder on (b) than recommended — "at whatever cadence is possible" was explicit. Sync protocol is trigger-agnostic; (a)+manual "sync now" are the only contracted triggers; (b) is a contract-free accelerant gated behind an on-device prototype checklist item (lock/reboot/force-quit/low-power). Silent-push-triggered sync named as future lever, not designed. [guess: including (b) in scope now rather than deferring]

---

## Q2 — initial backfill scope — 2026-08-04
(a) full immediate backfill; (b) forward-only; (c) forward-sync immediately + explicit throttled resumable backfill job. Sub-claude recommends (c), noting high-volume stream concerns and event batching implications.

## A2
(c) agreed. Riders: newest-first backfill [guess: fits screenshot use case]; events per sync-pass batch not per photo (batch event carries array of asset records + stored paths); simple max-N-per-pass safety cap.

---

## Q3 — iOS Limited Access degraded state — 2026-08-04
(a) block on limited access, require full; (b) degrade gracefully, sync visible subset + soft banner. Sub-claude recommends (b).

## A3
(b) agreed. Sync pass agnostic to visible-library size; soft banner; one task-file line about the three-way prompt / accessPrivileges.

---

## Q4 — ingestion path: addFiles into a collector agent vs email-ingress-style door — 2026-08-04
(a) agent.addFiles into dedicated agent (free chat browsing, but batches live in agent context forever); (b) direct itx.files + bespoke project-level photos-synced event mirroring email ingress. Sub-claude recommends (b), pending verification itx.files is callable from mobile capnweb stub.

## A4
(b), no hesitation. Path layout follows email ingress (/photos/inbound/<stableKey>-<filename>); dedup key from localIdentifier + content hash, never random. If itx.files not reachable from mobile, fix the seam rather than fall back to (a). Sub-claude verified: itx.files.put and streams.append both client-callable over existing capnweb socket — zero new seam.

---

## Q5 — dedup source of truth (no R2 listing layer) — 2026-08-04
(a) client-local only; (b) server index only; (c) client cursor as fast path + processor reduced state as durable source of truth with alreadySynced(stableKeys[]) query. Sub-claude recommends (c).

## A5
(c) agreed. alreadySynced lives on the collector capability surface; client cursor is disposable cache — wiping it and reconciling from server must always be safe.

---

## Q6 — what a rule's action IS — 2026-08-04
(a) fixed structured action vocabulary; (b) free-text instruction handed to the LLM step after cheap structured match; (c) full user TypeScript validated by itx.docs.typecheck. Sub-claude recommends (b).

## A6
(b). Riders: rule shape mirrors egress (ordered, ruleKey, description, structured cheap match, wholesale replacement, first-match-wins [guess: over all-matching — simpler; revisit for multi-category]); LLM step returns structured result envelope (category, extractedUrl, extractedText, notes) — instruction controls content not shape; (c) typecheck-validated rule scripts noted as future work.

---

## Q7 — cost gate: when does OCR run? — 2026-08-04
iOS tags screenshots natively (mediaSubtypes 'screenshot' — free). (a) OCR everything; (b) OCR gated on free isScreenshot flag, one shared OCR pass feeds all rule matching; (c) dynamic two-pass gating per rule set. Sub-claude recommends (b).

## Q7 hiccup
Sub-claude misread A7 as a background-task notification and held; A7 restated verbatim as an explicit user turn; accepted.

## A7
(b) confirmed. mediaSubtypes/creationTime/dimensions captured on-device before recompression, carried in per-asset records. Layers: 0 = on-device metadata (free); 1 = shared OCR via ai.run cheap model, screenshots only, cached per asset; 2 = LLM instruction for rule-matched only. (c) future optimization.

---

## Q8 — where results land — 2026-08-04
(a) event + processor state, queryable via listByCategory/getResult RPCs; (b) also write per-category index files; (c) (a) now, (b) future. Sub-claude recommends (c)/(a)-for-MVP.

## A8
(c)/(a)-for-MVP. Rider: dogfood read surface is itx scripts — listByCategory/getResult/signed-url must make "this week's interesting-tech-articles with links" a three-line script. Future: per-category markdown digests; gallery lens as fifth lens per tasks/workspace-lenses-consolidation.md.

---

## Q9 — ownership: which device syncs into which project — 2026-08-04
(a) explicit per-device opt-in, possibly multiple projects; (b) one project per device enforced. Sub-claude recommends (a), noting sync is device-initiated push so no first-phone race.

## A9
(a). Explicit per-device per-project opt-in; task file must answer the location-reminders comparison head-on (device-initiated push, no first-phone race). Toggle state lives on-device [guess: device-local rather than server registry — device is the actor; server just sees who appends].

Sub-claude finding: egress rules have no settings UI — configured by itx call only; photo rules follow suit for MVP (photos-rules-configured via itx script, no settings screen).

---

## Q10 — MVP cut: horizontal vs vertical slice — 2026-08-04
(a) horizontal (sync → backfill → rules → bg refresh); (b) vertical thin slice through every layer (no backfill/BG in M1). Sub-claude recommends (b). Also asks: is the X-post rule the right M1 rule, or a simpler "any screenshot → uncategorized + text" first?

## A10
(b) vertical. Simple rule ("any screenshot → uncategorized + extractedText") is the built-in spec/e2e fixture proving the spine; the X-post rule is pure config (match + instruction string) and serves as M1's dogfood acceptance demo on the real project, allowed to be imperfect (URL recovery via itx.mcp.exa from handle+text). If the X-post rule needs any code beyond config, that's a rule-model design bug.

---

## Termination — 2026-08-04
Sub-claude ran the stopping-rule checklist across all branches (capture, transport/dedup, storage/index, rules model, pipeline layers, outputs, ownership, MVP cut), found nothing in tension, declared "Ready for Phase 2."

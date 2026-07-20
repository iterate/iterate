---
status: in-progress
size: small
---

# Substitute project Secrets in JSON request bodies

**Status summary:** implementation and local verification are complete. Controlled egress now supports explicit, exact-value JSON substitution without changing any consuming domain. Preview deployment and trace verification remain.

## Outcome

Project egress can safely place write-only Secret material into JSON API requests. Callers opt in per request, while the existing Secret cell continues to own decryption, origin confinement, redirect checks, and usage auditing.

## Checklist

- [x] Add an explicit JSON-template opt-in; ordinary JSON bodies remain untouched. _`x-iterate-secret-template: json` gates parsing and is consumed before terminal fetch._
- [x] Recursively replace only complete string values matching `getSecret(path)` or `getSecret(path, { field })`. _Objects and arrays are traversed after parsing; embedded references and object keys remain unchanged._
- [x] Reject malformed JSON, unsupported content types/modes, oversized bodies, and unresolved marked templates before vendor egress. _Stable Secret error responses cover each invalid request shape and parsing is capped at 1 MiB._
- [x] Preserve the one-project-secret-per-request rule, origin pins, redirect validation, and usage audit. _Substitution remains inside the Secret Durable Object's existing fetch boundary._
- [x] Document the public request shape and provide an executable example. _The Secrets design, ADR, ITX description, and Postman Echo example cover marked JSON bodies._
- [x] Add unit and real-worker coverage. _Tests cover nested values, structured fields, exact matching, marker stripping, validation failures, and public project egress._
- [ ] Verify a stacked preview deployment and audit its traces for coherent, unexplained-error-free behavior.

## Assumptions

- This PR is stacked on `mobile-repo-native-markdown` / PR #2143 and does not alter that branch.
- JSON substitution is explicitly enabled per request rather than inferred from `Content-Type`.
- References occupy complete JSON string values. Existing header and URL-path interpolation retain their behavior.
- Consuming domains, including Devices, are intentionally out of scope and can adopt this capability in separate PRs.

## Implementation log

- 2026-07-20: added recursive exact-value JSON substitution, body validation and limits, documentation, generated discovery, and a real-worker egress proof.
- 2026-07-20: split the original Devices integration into a separate stacked change so this PR exposes only the reusable Secrets capability.

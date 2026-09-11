# Tutorial and console

The public page is a progressive explanation and a real API console. Each
lesson names its implementation status rather than pretending that a future
worker, repository, secret or approval endpoint has already run. Its working
controls use the public API only: append, replay, inspect and `/events` follow.

The console begins on a random project id. It exposes project and context-path
inputs, an editable JSON event, and optional Ed25519 signing in the current
browser session. Signing obtains the canonical full project/context name from
`inspect`, not merely the displayed path; signatures cannot replay into another
project. Its tiny canonical JSON/signing implementation temporarily
duplicates `src/signatures.ts`; it binds `iterate.event.v1`, context, id, type,
data, claimed parents and optional producer, but excludes signatures. A shared
browser build can replace that duplicate later.

The UI renders server-provided verification level and verified signers. It does
not claim the level locally; the append gate remains the only authority that can
produce `EventRecord.verification`. Claimed provenance is signable event data;
context, offset and time are platform-observed committed facts. Signatures are
collected before append; a later co-signature would be a new `event.endorsed`
fact (proposed, not implemented), never a mutation of history.

Every tutorial step displays concrete code. Source paths refer to the checkout;
the server does not pretend to serve files outside its public assets directory.
The console ACKs each received stream page, and changing its project/path closes
the old subscription and clears its display. Browser proof so far is local,
not the deployed acceptance required by the completion contract.

# Event provenance, signatures, and endorsements

**Status: design note for the implementation in `src/signatures.ts` and
`src/stream.ts`.** This note answers a narrower
question than authentication: what durable facts let a project later explain
who claimed an event, which cryptographic statements arrived, which policy
admitted it, and what the platform actually observed? It is intentionally a
small vocabulary for the core, rather than an attempt to embed a general
provenance graph or a JOSE/attestation framework.

The useful conclusion is: **a signature is one kind of provenance assertion**.
It proves that the holder of a key made a precise statement. It does not prove
that the person named by the key is who they claim to be, that the event was
accepted, or that an external effect happened. Those are separately owned
facts, with separately checkable evidence.

## Prior art that informs the split

- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) models entities, activities,
  agents, derivation, attribution, and association. Its most helpful idea here
  is a **bundle**: a named set of provenance descriptions which is itself an
  entity, so it can have provenance of its own. That maps cleanly to an
  immutable event claim plus independently added endorsements. PROV is a
  conceptual interchange model, not a signing or append protocol; do not put
  its graph vocabulary into the hot path.
- [DSSE 1.0.2](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
  signs `PAE(UTF8(PAYLOAD_TYPE), SERIALIZED_BODY)`: both the exact bytes and an
  application-specific type are authenticated. Its multi-signature rule is
  directly relevant: a `(t,n)` envelope accepts at least `t` **unique trusted
  public keys**. It also says the verified body must be the body sent onward,
  rather than parsing a different copy after verification. Borrow the type
  binding, exact-byte discipline, and unique-key threshold; a full DSSE
  envelope is optional while this core only supports Ed25519.
- [JWS RFC 7515, section 7.2](https://www.rfc-editor.org/rfc/rfc7515#section-7.2)
  defines a general JSON serialization whose `signatures` array carries more
  than one signature over one payload. It is proof that “one payload, many
  independent attestations” is normal prior art. It is a wire format with
  algorithm/header negotiation; importing all of JOSE would add more surface
  than this core needs.
- [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  and [SLSA provenance v1.1](https://slsa.dev/spec/v1.1/provenance) distinguish
  stable subjects/dependencies from details of a particular run, including the
  builder identity and invocation timestamps. That distinction is the right
  analogue for a client’s claim versus the stream’s commit observation.
- [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) exists because
  signatures need invariant bytes. Its JSON rules are a good conformance
  target if arbitrary implementations must sign JSON. Its number and Unicode
  behavior is a warning against calling an ad-hoc recursive serializer
  “canonical” without cross-runtime test vectors.
- [HTTP Message Signatures RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)
  gives a useful context-binding pattern: signatures explicitly cover derived
  request components such as method, target URI, authority, and signature
  parameters. An Iterate signature likewise needs to cover _which context_
  and _which statement schema_, not merely user data.

## The three facts that must not blur together

| Fact          | Owner           | Example                                         | What it establishes                                            |
| ------------- | --------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `claim`       | submitter       | `task.approve`, request id, exact effect digest | A stable proposition someone can sign and retry.               |
| `endorsement` | signer          | Ed25519 signature by Alice’s key over the claim | This key made this particular statement.                       |
| `commit`      | stream/platform | offset 91 accepted under trust revision 40      | The context ordered and admitted this claim under this policy. |

The core signs the caller-owned claim and records platform-owned `context`,
`offset`, `time`, and verification only after admission. Its flat
`provenance.signatures` array allows co-signers supplied together, while a
later endorsement remains a new, explicit event. The claim identity therefore
does not become mutable.

## The core's compact envelope

This is the intended compact shape for `src/signatures.ts`, expressed here as
plain TypeScript so the provenance semantics are visible. It deliberately keeps
the event flat: `provenance` is part of the caller's signed claim; the stream
adds its own observed commit record.

```ts
type EventInput = {
  id: string; // submitter retry/idempotency identity
  type: string; // "approval.granted"
  data: Json; // application statement
  provenance?: {
    parents: string[]; // declared causal inputs; see parent grammar below
    producer?: string; // self-asserted identity/role, not authenticated identity
    signatures: Signature[];
  };
};

type Signature = {
  key: PublicJwk;
  value: string; // base64url Ed25519
};

type EventRecord = EventInput & {
  context: string; // platform address, never supplied by caller
  offset: number;
  time: number; // platform wall-clock observation
  verification: {
    level: 0 | 1 | 2;
    signers: { keyId: string; trusted: boolean }[];
    policyOffset: number; // trust setting re-read in the commit transaction
  };
};
```

The byte sequence for an event claim signs exactly this structure:

```ts
canonical({
  domain: "iterate.event.v1",
  context,
  id: event.id,
  type: event.type,
  data: event.data,
  provenance: {
    parents: event.provenance?.parents ?? [],
    producer: event.provenance?.producer,
  },
});
```

The signature array is deliberately excluded from its own signed bytes. `context`,
domain, version, and type are inside them. Thus a
signature made for `/payroll` cannot be copied to `/support`, and a future
schema cannot silently reinterpret an old signature. A caller does **not** sign
`offset`, `time`, verification level, or current trust policy because
those facts do not exist until the stream makes the commit.

For cross-language portability, pick one of these before publishing a client
SDK:

1. adopt RFC 8785/JCS exactly and retain published vectors; or
2. define an explicit binary field encoding for `EventInput`.

The current JavaScript-only serializer may be an acceptable interim choice for
browser + workerd + CLI, but must have vectors for non-ASCII keys, Unicode
normalization, `-0`, exponents, nested records, and key ordering before another
runtime is expected to reproduce it. Never verify one parsed JSON value and
hand a separately parsed body to application code.

## Two signatures are normally two independent statements

Two approvers sign the same claim digest. The stream checks a `2-of-3` policy
by distinct computed public-key IDs, never by the number of signature objects.

```ts
const event = {
  id: "approve-7",
  type: "payment.release",
  data: { requestDigest: "sha256:Kf…", amount: { currency: "GBP", minor: 25_000 } },
  provenance: { parents: ["request:sha256:2Y…"], producer: "payroll-bot", signatures: [] },
} satisfies EventInput;

const alice = signEvent("acme/payroll", event, alicePrivateKey);
const bob = signEvent("acme/payroll", event, bobPrivateKey);
await stream.append({ ...event, provenance: { ...event.provenance, signatures: [alice, bob] } });
// `alice` twice is rejected (and must never count as two keys). A malformed
// signature is rejected before the claim can satisfy a signature policy.
```

At commit, re-read the trust state inside `transactionSync`, then persist the
observed outcome for every submitted signature:

```ts
type VerifiedSigner = {
  keyId: string;
  trusted: boolean; // computed from trust policy read in this transaction
};
```

This does not make stale trust magically safe. The stream verifies asynchronously
first, then computes `trusted` against the transaction’s current policy
and rejects if the required unique trusted keys are absent. Recording both the
immutable result and `policyRevision` lets a later reader distinguish “valid
but untrusted then” from “trusted then, revoked now.”

## Countersignatures are a different relationship

A countersignature should not be an ambiguous second ordinary signature. It
signs a particular endorsement’s identifier, and says what that second-order
assertion means:

```ts
const witnessed = signEvent(
  "acme/payroll",
  {
    id: "witness-approve-7-auditor",
    type: "itx.endorse",
    data: {
      subjectClaimDigest: claimDigest(event),
      subjectSignature: alice.value,
      purpose: "witness",
    },
    provenance: { parents: ["claim:sha256:…"], signatures: [] },
  },
  auditorKey,
);
```

The auditor has attested to “I saw/accept this author signature,” not necessarily
to the business proposition itself. This is the small operational version of
PROV’s provenance-of-provenance bundle. A `delegate` endorsement should name a
specific delegation claim or durable grant in `data`; do not encode vague
authority in an unstructured purpose string.

## Same-ID retry versus later endorsement

`EventInput.id` remains the idempotency key. A matching retry must have
byte-identical claim content or receive `ID_CONFLICT`. The original append
contains all co-signatures required for admission. A later signer does not
silently mutate its `signatures` array; an explicit signed endorsement event
has its own event ID and references the original claim digest:

```ts
// First request opens the claim but misses the 2-of-2 policy.
await stream.submit({ ...event, provenance: { ...event.provenance, signatures: [alice] } });

// Bob does not rewrite event 91. He appends an independently ordered fact.
await stream.append({
  type: "itx.endorse",
  data: { subjectClaimDigest: claimDigest(event), endorsement: bob },
});
```

There are two valid semantics; select one per event family and state it in the
type contract:

- **admission-time threshold:** `payment.release` enters only once all required
  signatures are present. A partial proposal is an ordinary
  `payment.release.requested` claim.
- **progressive endorsement:** the business claim can enter once, and a derived
  reducer makes it effective only after endorsement events satisfy the policy.

The second is more naturally append-only and supports human approval arriving
later. It must make the effect gate consume an exact effective-approval state
atomically, so a second endorsement cannot race into two external payments.

## What to expose as “signature level”

A single integer hides too much once there are multiple signatures. Preserve a
simple UI summary, but derive it from detailed provenance:

```ts
const provenance = {
  authoredBy: [aliceKeyId],
  approvedBy: [aliceKeyId, bobKeyId],
  trustedApprovalsAtCommit: 2,
  requiredApprovals: 2,
  effective: true,
};
```

The old levels remain useful as an ingress compatibility summary—`0` unsigned,
`1` valid-but-untrusted, `2` at least one trusted signer—but are insufficient
for “two humans approved this payment.” A UI should show the key identities,
purposes, policy revision, and effective state, while separately mapping keys
to mutable user profiles or membership claims.

## Deliberately excluded from the core

- X.509 chains, JWK URLs, algorithm negotiation, and remote key discovery.
  The core accepts pinned Ed25519 public keys and derives its own key ID.
- A generic PROV graph, timestamps asserted by clients, and claims of human
  identity. Applications can project these from durable signed facts.
- An implicit re-sign operation. Re-signing and endorsement are ordinary,
  explicit append-only facts with their own IDs and offsets.
- Using a signature as proof of external delivery. Model provider receipts as
  separate observed events, retaining a provider receipt or digest where
  available.

## Minimal end-to-end examples to require before adopting it

1. Alice’s `/payroll` signature fails in `/support` and when `type` changes.
2. Two signatures from Alice do not satisfy a 2-key threshold; Alice + Bob do.
3. A valid key revoked between asynchronous verification and commit does not
   satisfy admission; the commit records the policy revision it read.
4. A same-id altered claim gets `ID_CONFLICT`; a later Bob endorsement remains
   an additional ordered fact and makes a pending approval effective once.
5. A countersignature over Alice’s endorsement is not counted as Bob’s direct
   approval of the claim unless that event family explicitly says so.

# Signed provenance: claims, co-signers and observations

`src/signatures.ts` uses standard WebCrypto Ed25519 and canonical JSON. An
event may be unsigned or carry up to sixteen signatures over the same claims:

```ts
const event = {
  id: "review-42",
  type: "document.reviewed",
  data: { document: "/workspaces/review/notes.md", revision: "r_3" },
  provenance: {
    parents: ["edit-41"],
    producer: "review-ui",
    signatures: [
      { key: alicePublicJwk, value: aliceSignature },
      { key: bobPublicJwk, value: bobSignature },
    ],
  },
};
```

The bytes include `domain: "iterate.event.v1"`, context, id, type, data,
`provenance.parents` and optional `provenance.producer`. They exclude all
signatures and server-assigned metadata. All co-signers therefore sign the
same content independently. Parents currently name claimed same-context event
IDs; existence and causality are not proven. A producer label is not an
authenticated person or proof that a particular worker executed.

The platform records immutable commit-time observations separately:

```ts
record.verification = {
  level: 2,
  signers: [
    { keyId: "ed25519:…", trusted: true },
    { keyId: "ed25519:…", trusted: true },
  ],
  policyOffset: 27,
};
```

Level 0 means unsigned; 1 means at least one valid signature but no currently
trusted signer; 2 means at least one trusted signer. `minSigners` can require
multiple distinct valid or trusted keys according to the configured minimum
level. Invalid signatures and duplicate keys are rejected, not ignored.

Crypto happens asynchronously before the transaction and returns only distinct
verified signer key IDs, not a provisional trust decision:

```ts
const signerKeyIds = await verifyEvent(contextName, input);
// Inside Stream's synchronous commit, under the then-current policy:
const signers = signerKeyIds.map((keyId) => ({
  keyId,
  trusted: trust.keys.includes(keyId),
}));
```

The transaction reads the current policy once and advances that local value
when an earlier event in the same batch changes it. The setter itself is
governed by the previous policy. Historical
verification records are never recalculated under today's trust list. These
are platform-stamped observations, not a platform cryptographic signature.

An identical event is an idempotent retry. Changing its signature list is not:
append-only records cannot be silently amended. Later co-signing can be modelled
as a new signed endorsement event pointing at the earlier claim; that higher
level endorsement policy is not implemented yet.

Ten network E2Es passed against local workerd on 2026-09-05, covering unsigned,
unknown and trusted signatures, two-key policy, duplicates, tampering with
data/parents/producer/signature bytes, cross-context replay, idempotency and
forged platform metadata. The tenth case proves within-batch key rotation,
atomic rollback, stale-key rejection and immutable policy evidence on retry
and replay. [Exact sequence and query-cost evidence](../evidence/trust-read-cost.md).
The tampering cases now retain the same ID while independently changing each
signed field. This is local runtime evidence, not deployed acceptance.
Node's optional JWK `alg` label differs from workerd's accepted label: the
verifier imports only standard `kty`, `crv` and `x` public fields.

Additional JWK metadata currently passes through validation and is retained,
but is not signer-attested. For example, adding `signature.key.displayName`
after signing does not invalidate the signature; a UI must not treat that
label as a verified identity. Use `record.verification.signers[].keyId` and
your own trusted identity directory for that purpose. A
[public boundary probe](../evidence/read-page-cost.md) also verifies that a
300 KB extra key field is retained exactly and delivered alone when its
envelope exceeds the normal read-page budget. This does not enlarge the
signature's claim or bypass the existing append limit.

See [prior art](provenance-prior-art.md) for W3C PROV, JWS multi-signatures,
DSSE and in-toto/SLSA. The custom envelope borrows the separation of concerns;
it does not claim wire compatibility with those standards.

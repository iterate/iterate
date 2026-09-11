# Interesting ideas to try deliberately

These are product experiments, not a hidden roadmap. **Implemented** means the
named building block exists in `src/` today; **proposed** needs design and an
end-to-end proof; **fork** belongs in a separate runnable sibling if pursued.
The provenance direction below is deliberately plural: an event can carry many
signatures over its claims. The platform separately records its observations;
cryptographically signing platform receipts is a further proposal. The current
plural signature envelope has ten public-network tests passing locally and
in the domain preview's 44-test suite. Operational acceptance is tracked
separately in [the domain proof](evidence/domain-preview.md).
[Exact contract](notes/signatures.md).

Current identifier direction: a context is exactly `{ projectId, path }`.
Inside it, dotted ITX resolves a configured worker or live-stub mount and
forwards the remaining members; `builtins` explicitly reaches physical core
operations. Paths remain project names, like files, but resource facets are
application experiments rather than a new core registry. The
[identifier exploration](IDENTIFIERS.md) keeps its alternatives explicitly
optional.

## 1. A security upgrade is an ordinary co-signed fact

**Status: proposed atop the existing trust-setting foundation.** A new project
can start open and commit the exact moment it stops being open. More than one
person can attest the same fact without inventing a separate quorum object:

```ts
await root.append({
  id: "lockdown-2026-09-04",
  type: "itx.set",
  data: { key: "trust", value: { keys: [founderKeyId], minLevel: 2 } },
  provenance: { parents: [], signatures: [founderSignature, securityOfficerSignature] },
});
```

For example, a public bug-report project accepts anonymous
`issue.reported` events during its first week. The founder appends this fact;
later reports need a key in the recorded set. Replay answers exactly when the
wall moved, whose statements authorized it, and which statements were valid at
the time. The useful sharp edge is real: the project can lock itself out. Do
not add an operator backdoor; require a separate, explicit recovery key if the
product wants one. The missing proof is a deployed scenario covering unsigned
bootstrap, two required co-signers, rejected post-lockdown input, and key
rotation.

## 2. An approval is a one-shot capability, not a boolean on a request

**Status: implemented exact-request egress foundation; proposed payment API.**
A payment approval should name the exact effect, bind its
parameters, and be consumed once. The approver signs a hash of the request
event rather than signing a vague "yes":

```ts
// request event at offset 41
{ type: "payment.requested", data: { merchant: "acme.test", cents: 2_500, currency: "GBP" } }

// two people make separately verifiable claims about the same exact request
{ type: "approval.granted", data: { requestOffset: 41, effectHash, expiresAt: 1_789_000_000_000 },
  provenance: { parents: ["payment-request-41"], signatures: [financeSignature, founderSignature] } }
```

The egress terminal calculates its fingerprint from the installed policy offset,
method, normalized URL, headers, body hash, and secret names/revisions; it consumes the grant atomically before sending the HTTP
request. An agent cannot reuse the approval for £25,000, redirect it to another
host, or retry it after expiry. The tradeoff is that long-lived human holds
cannot keep a request alive across eviction: return `202` plus request offset,
then issue the effect only after the later approval event. One-use dispatch
does not mean exactly-once provider execution: a lost response leaves an
uncertain outcome requiring provider idempotency or explicit reconciliation.

## 3. A repo revision can carry both code identity and authority history

**Status: partly implemented.** `repo.commit` already derives its revision from
the canonical `{ files, parent, message }`, stores immutable blobs, and CASes
the named head in the same append transaction. Make the config selection a
separate event that points only at this immutable address and carries its
authorizing claims:

```ts
{ type: "config.activated", data: {
  source: { repo: "config", revision: "7f0c...64-hex-chars" },
  entry: "main.js",
  activatesAfterOffset: 128,
}, provenance: { parents: [], signatures: [maintainerSignature, reviewerSignature] } }
```

When a support bot sent an unexpected email, the project can answer two
questions without consulting a mutable branch: which source bytes handled the
event, and which trusted signer activated them? A compiled bundle may be cached
under this revision, but its output digest is a separate identity, not a
substitute for the source revision and build inputs. The tradeoff is a
deliberate update ceremony rather than silently running `config@head`.

## 4. The tutorial can be the portability contract

**Status: proposed.** Build each tutorial page as an action against a deployed
URL, then run the same source as an E2E conformance suite:

```ts
await lesson("03-signed-lockdown", async (project) => {
  await project.append(unsigned("note.created", { text: "before" }));
  await project.append(signed("itx.set", trustOnly([alice])));
  await expect(project.append(unsigned("note.created", { text: "after" }))).rejects.toMatchObject({
    code: "SIGNATURE_REQUIRED",
  });
});
```

The browser shows the same two accepted events, their offsets, and the rejected third
request. A Cell/Deno/workerd implementation passes by serving the same public
protocol and producing the same observable log, rather than by reproducing a
Durable Object's internals. The constraint is healthy: a lesson cannot depend
on private SQLite rows, local clock quirks, or an unexported worker binding.

## 5. Spending can be an attenuated causal capability

**Status: proposed.** Give a worker a durable budget grant tied to a purpose,
not a reusable secret:

```ts
{ type: "budget.granted", data: {
  grant: "research-42", parentOffset: 88, limit: { currency: "USD", cents: 500 },
  maySpendAt: ["api.openai.com"], expiresAt: 1_789_000_000_000,
} }
{ type: "budget.spent", data: { grant: "research-42", requestOffset: 91, cents: 37 } }
```

The fetch gate checks a remaining balance while committing the spent fact, then
substitutes the platform credential only for the approved origin. A research
agent can buy $5 of model calls because an approved parent event granted it;
the audit trail explains the causal chain from human approval to each charge.
The cost is accounting semantics: decide whether failed attempts reserve,
release, or consume a grant before shipping this beyond a single currency and
one egress provider.

## 6. Separate signed claims from platform observations

**Status: proposed.** A human or config worker can sign the claim "send this
request". It must not sign the platform's later observation as though it saw
the network. The gate alone appends a compact attested receipt after attempting
the effect:

```ts
{ type: "fetch.completed", data: {
  requestOffset: 91, routeRevision: "f31a...", status: 201,
  responseDigest: "sha256:...", elapsedMs: 184,
}, provenance: { platformAttestation: { kind: "egress-gate", commitOffset: 92 } } }
```

For a customer email, retain recipient domain, message digest, provider request
id, and status rather than secret-bearing headers or the full body. A replay
can rebuild the decision state and say "the code attempted this effect"; the
platform attestation says what its gate observed; only a provider signed receipt
can claim what a third party acknowledged. The tradeoff is privacy and storage:
declare per-event retention and redaction rules, and make platform attestation
writeable only by the commit/effect seam.

## 7. Put common provenance in the envelope to buy both memory and clarity

**Status: envelope implemented; proposed application conventions.**
A conversation processor should use the signed claims and
platform observation from the envelope instead of embedding caller-controlled
identity metadata in every application payload:

```ts
const author = event.verification.signers.find((signer) => signer.trusted)?.keyId ?? "anonymous";
if (event.type === "message.posted")
  state.messages.push({
    offset: event.offset,
    author,
    text: event.data.text,
  });
```

For a busy inbox, this removes repeated 200-byte identity objects from every
message and makes one readable audit vocabulary across UI, MCP, and workers.
It also prevents an app from accidentally trusting a caller-controlled
`data.author`. A trusted signer is not automatically the author: this compact
example's policy selects a trusted key; a multi-role app needs an explicit
signed author claim and a verifier-to-profile mapping. Profile labels and
membership are separate, changing data, not conclusions from a signature.

## 8. A forked project is a safe, executable counterfactual

**Status: fork.** A simulator can copy a root log and immutable repo revisions
into `project-core-sim`, but replace the egress terminal with a recorder:

```ts
const sim = await ProjectSimulation.from({ project: "acme", throughOffset: 2_400 });
await sim.append({ type: "config.activated", data: candidateConfig });
await sim.replay();
expect(sim.effects).toEqual([{ method: "POST", host: "sandbox.mail.test", blocked: true }]);
```

This lets a founder test a new config worker against last month's support log
without sending a real email or charging a card. Revisions and signed events
remain identical to production; only explicitly injected nondeterminism
(clock, fetch fixtures, random seed) differs. Keep this as a sibling runtime
until it proves its value: sharing too much execution code can accidentally
create a privileged production bypass.

## 9. Build branches are cache policy, never a mutable source address

**Status: proposed.** Developers may want a preview branch, while the runtime
needs immutable source. Represent the branch lookup as a build step that emits
an ordinary repo commit and activation request:

```ts
{ type: "repo.imported", data: { name: "config", remote: "github:acme/app", ref: "preview" } }
{ type: "config.activation-requested", data: { repo: "config", revision: "7f0c...", checks: ["e2e"] } }
```

The importer resolves `preview` once and commits the actual file map. The
preview URL can show its revision in `/version`; production activation then
selects that same digest. The tradeoff is no magical live branch execution,
which is precisely what makes a later incident or approval replayable.

## 10. A reproducible config producer records its causal inputs

**Status: proposed.** Let a project generate a config revision from a pinned
producer and named input facts, but make the derivation independently rerunnable:

```ts
{ type: "config.produced", data: {
  producer: { repo: "config-tools", revision: "a19d...", entry: "main.js" },
  output: { repo: "config", revision: "7f0c..." },
}, provenance: {
  parents: ["accepted-issue-700", "github-import-44"],
  signatures: [automationKeySignature],
} }
```

For a company that turns accepted GitHub issues into a support-routing update,
the producer runs against those immutable source bytes and exact event records,
then emits a normal `repo.commit`. A reviewer can re-run it in a simulation and
compare the output revision before co-signing `config.activated`. The tradeoff
is that a producer must declare its clock, network fixtures, model version, and
random seed; undeclared ambient input makes the causal claim false. Current
parents are same-context event IDs; cross-context causal references would need
an explicit envelope extension and retrieval/verification contract.

## 11. Optional app facet: a path can identify a resource without owning a process

**Status: optional application experiment.** A mounted Docs app can keep the
filesystem-like vocabulary while one workspace context owns many document paths:

```ts
const doc = project.docs.open("/workspaces/review/notes.md");
await doc.edit({ baseVersion: 12, change });
```

`/workspaces/review` can be the context address; `notes.md` is app-owned
row/key state behind that app's mount. Not every path creates a DO, stream,
isolate or global identity record. The difficult promise is conditional
acceptance: two concurrent edits at version 12 need OT/rebase or an explicit
conflict, not just two log rows.

## 12. Optional app contracts alongside mounts

**Status: proposed.** A configuration revision installs an app and pins its
TypeScript contract together:

```ts
const docs = { path: "/apps/docs", source: DOCS_SOURCE, contract: DOCS_TYPES_HASH };
// The same contract feeds completion, deployed build checks and typed E2Es.
type MyProject = Core & { docs: Docs };
```

This lets a project grow a typed interface without teaching the kernel every
app. Runtime validation and grant checks remain necessary. A declaration hash
identifies declarations; it does not prove a remote object behaves as declared.

## 13. A build can be a co-signed provenance claim

**Status: proposed.** Treat a build as a reproducible transformation, not an
opaque side effect of the first request:

```ts
const claim = {
  id: "build-42",
  type: "code.built",
  data: {
    source: SOURCE_HASH,
    dependencies: LOCK_HASH,
    compiler: COMPILER_HASH,
    contract: TYPES_HASH,
    outputDigest: OUTPUT_HASH,
  },
  provenance: { parents: ["repo-commit-41"], signatures: [builderSignature] },
};
```

A reviewer can approve the exact bundle after inspecting a preview. A build
input key and output digest are separate; rebuilding with a different dependency
closure must not borrow an earlier approval.

## 14. Review links can pin a historical view of a path

**Status: proposed.** A path remains the public name, but a link can explicitly
request what was reviewed:

```ts
const review = { path: "/workspaces/review/notes.md", atCommit: COMMIT_HASH };
const current = { path: "/workspaces/review/notes.md" };
```

This is useful for signatures: "approved this path" changes meaning as files
change; "approved these bytes at this path" does not. If rename must preserve
open-handle behavior, use an internal inode-like key rather than imposing a
second public stable-ID vocabulary.

Rename should append history, not rewrite it:

```ts
{ type: "document.moved", data: {
  from: "/workspaces/review/notes.md",
  to: "/workspaces/review/introduction.md",
  expectedVersion: 12,
}, provenance: { parents: ["review-42"], signatures: [editorSignature] } }
```

The old approval still names the old path and bytes. The new fact explains
the move within the workspace's stream. Today's core binds signatures to the
original project/context name too: moving a resource inside an app is not
permission to transplant its signed events into a different context. Context
rename and history relocation would require their own explicit protocol.

## 15. The compiler can check the capability budget, too

**Status: proposed UX, never a security mechanism.** Give a document plugin a
smaller declared interface than the whole project:

```ts
interface DocumentPluginHost {
  read(path: string): Promise<string>;
  propose(change: ProposedEdit): Promise<void>;
}
// host.fetch(...) and host.secrets(...) produce diagnostics.
```

The runtime must supply exactly that narrow capability as well. Now a missing
method produces an early editor diagnostic and a runtime denial. Granting the
whole project while merely hiding methods in `.d.ts` would defeat the idea.

## 16. An inbox is a set of narrow write capabilities

**Status: proposed.** Treat each inbound integration as permission to append a
small event family to one context, rather than as a broad application secret:

```ts
{ type: "inbox.installed", data: {
  name: "github-issues", context: "/inbox/github", accepts: ["github.issue", "github.comment"],
  keyId: webhookKeyId,
} }
```

The ingress verifier checks GitHub's signature, maps it to `webhookKeyId`, and
rejects any event type or destination outside that install. The config worker
can reply through the same fetch policy (including any required approval), but cannot reinterpret a
GitHub webhook as `itx.set` or `repo.commit`. This gives the UI a useful
installation screen—"can write these facts here"—and makes uninstall a
replayable revocation. The tradeoff is connector-specific verification at the
edge; retain that thin adapter instead of putting provider parsing into the
event stream.

## 17. A project file browser can be a view, not another database

**Status: proposed.** If most resources have paths, the project can have one
explorer without a kernel row for every document, worker and secret. Installed
apps can contribute listings under their configured prefixes:

```ts
// Explorer metadata is display data, not live capabilities or secret material.
const entries = [
  { path: "/workspaces/review/notes.md", kind: "document" },
  { path: "/workers/summarize", kind: "worker" },
  { path: "/secrets/mail", kind: "secret" },
];

// The selected resource is still opened through its typed interface.
const note = project.docs.open("/workspaces/review/notes.md");
await note.read();
```

For example, Docs lists its existing workspace rows and the worker app lists
its configured installations. The explorer combines those views; moving a
document changes the owning app's state, not a second authoritative explorer
database. An installation must explicitly own its prefix or declare a shared
view; typed factories must not accidentally create unrelated namespaces with
the same spelling.

The tradeoff: a cross-app listing is not automatically an atomic project-wide
snapshot. Paginate it, apply visibility grants before returning names, and
recheck authority and resource kind when opening. The displayed `kind` is not
proof that a runtime path implements a TypeScript interface. Prefix ownership
does not imply a DO per prefix, and listing a secret must never reveal its
material. This is a userspace explorer layer, not a new requirement for the
minimal stream kernel.

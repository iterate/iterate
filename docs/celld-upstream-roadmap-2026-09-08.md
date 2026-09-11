# celld upstream roadmap evidence — 8 September 2026

This note answers a narrow question: which celld features relevant to V4 are
already shipped, which are publicly tracked, and what the public GitHub record
actually says about timing. It is deliberately not a prediction from commit
velocity.

Scope clarification: the V4 blockers below concern preserving its current
**native Workers RPC transport**. They do not mean celld lacks ordinary bindings
or cannot carry another capability protocol. The
[Cap'n Web transport assessment](celld-capnweb-transport-alternative.md) explores
replacing those native-RPC hops while preserving the public ITX interface.

## Bottom line

- **Facets are shipped**, not only present on an unstable branch. They were
  released in [v0.4.1 on 5 September](https://github.com/denoland/celld/releases/tag/v0.4.1),
  at commit [`10cb1303`](https://github.com/denoland/celld/commit/10cb1303dac710dcb3b557e318e08c855261f68b).
- **Cross-isolate RPC** and the Worker Loader's `globalOutbound` / capability
  `env` bridge are open issues with **no public maintainer comment, assignee,
  milestone, PR, candidate build, or ETA** as of this date. That means no
  supportable calendar estimate.
- Ryan Dahl's directly relevant public roadmap statement is about isolation:
  multi-tenancy is an unscheduled future ambition, while the
  current aim is to get one application working well. It is not a commitment or
  timeline for cross-isolate RPC.
- A prior celld stream-lifecycle issue is closed as fixed in v0.4.0. That should
  not be conflated with V4's separate failure to serialize/transport a
  `ReadableStream` across an isolate boundary.

## What has shipped

### Durable Object facets — released in v0.4.1

| Evidence                                                                                                                                                                                                                  | Date   | Status                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| [Issue #176](https://github.com/denoland/celld/issues/176) requested `ctx.facets` and Worker Loader class access.                                                                                                         | 29 Aug | Opened by tboser.              |
| [Bartek Iwańczuk's comment](https://github.com/denoland/celld/issues/176#issuecomment-5543260560) says “This will ship in the next version!”                                                                              | 4 Sep  | Explicit near-term commitment. |
| [v0.4.1 release notes](https://github.com/denoland/celld/releases/tag/v0.4.1) list Durable Object facets: `ctx.facets.get()`, `abort()`, and `delete()`, with a separate SQLite database replicated with its root object. | 5 Sep  | Published release.             |

The release was authored by [Ryan Dahl](https://github.com/denoland/celld/commit/10cb1303dac710dcb3b557e318e08c855261f68b)
and explicitly lists #176 among the fixes. This is stronger evidence than an
unpublished branch: use v0.4.1 (or its exact commit) as the minimum facets
baseline.

The feature is described as **dynamic** facets for a class from a Worker Loader
in the release's commit message. That supports the V4 named-facet SQLite tests
which passed on v0.4.1. It does not, by itself, promise all dynamic-worker
capability plumbing.

### Streaming response lifecycle — released in v0.4.0

[Issue #159](https://github.com/denoland/celld/issues/159) reported that an
open streaming response could be idly evicted and left hanging. On 29 August,
[Bartek Iwańczuk replied](https://github.com/denoland/celld/issues/159#issuecomment-5461891844):
“This is now done as of v0.4.0.” The issue is closed.

The [v0.4.1 release notes](https://github.com/denoland/celld/releases/tag/v0.4.1)
also say each chunk of a streaming body waits on the relevant durability proof.
Those are server-side response-lifecycle/output-gate claims. They do **not**
state that an arbitrary `ReadableStream` is supported by cross-isolate RPC, so
they do not resolve V4's existing serialization failure.

### Some Web Crypto expansion — released in v0.4.1, but not a public Ed25519 commitment

The v0.4.1 release notes announce Web Crypto KDF derivation, key wrapping and
unwrapping, and RSA signing. [Issue #186](https://github.com/denoland/celld/issues/186)
was a separate RSA/EC `CryptoKey.algorithm` metadata bug. Ryan said on
[4 September](https://github.com/denoland/celld/issues/186#issuecomment-5541863958)
that its fix would ship in v0.4.1, and it did.

There is no celld GitHub issue, release note, or Ryan comment located through
the public repository that commits to Web Crypto `subtle.verify` for Ed25519.
Consequently, the demonstrated V4 Ed25519 verification gap has **no public
arrival date**. The source audit appended below distinguishes the narrow
implementation wiring gap from broader RPC work; neither is a published ETA.

## Open work with no published date

### Cross-isolate RPC, callbacks, pipelining, and V4 handles

[Issue #174, “Cross-isolate RPC”](https://github.com/denoland/celld/issues/174)
was opened by Ben Plotnick on 28 August. Its request is exactly the relevant
shape: pass stubs across an isolate boundary to a dynamic worker for tool
callbacks. It remains open, has no comments, no labels, no milestone, and was
last updated when created.

Therefore the public record supplies:

- a clear problem statement;
- no maintainer acceptance/rejection;
- no stated design for callbacks, promise pipelining, or stream transport; and
- no date, release target, or public implementation reference.

V4 should treat cross-isolate RPC as an upstream blocker, not as “expected in
the next beta”. The absence of a public commit is not evidence that the Deno
team has not worked on it; it only means there is no public delivery signal to
plan against.

### Worker Loader: `globalOutbound` and non-JSON `env` bindings

[Issue #177](https://github.com/denoland/celld/issues/177) was opened on 29
August and remains open. It records both alternatives relevant to V4:
`globalOutbound: fetcher`, or service/DO capability stubs inside the loaded
worker's `env`. It has no comments, labels, milestone, or later update (the
page's last update is 29 August).

Thus, even if `globalOutbound` is arriving through a private or candidate
development path, it cannot be dated or treated as publicly released from
GitHub today. The public v0.4.1 release notes say calls into loaded Workers wait
for proof of the writes they depend on; that is an output-gate/durability
property, not evidence that a loaded Worker can receive parent capabilities.

For V4, `env.ITX.get().fetch` would require the latter: a non-JSON capability
binding and cross-isolate stub behavior. It is not equivalent to adding an
ambient `fetch` implementation, and #177 does not promise either mechanism on
a schedule.

## What Ryan Dahl has said publicly

The directly relevant statement is on the security/trust-boundary discussion,
[issue #160](https://github.com/denoland/celld/issues/160). Ryan wrote on
[27 August](https://github.com/denoland/celld/issues/160#issuecomment-5433954671):

> currently we're aiming to just get one application working well.

He also considered an isolate-sharing toggle a reasonable request and
said he was open to it, but was not sure isolate separation alone formed a
security boundary without further changes. This is a useful architectural
signal: do not depend on celld becoming a hostile-multitenant capability
runtime on a near-term date. It is **not** a statement that ordinary
cross-isolate RPC or `globalOutbound` is rejected; he makes neither promise nor
timeline in public.

There is a concrete release-target statement elsewhere:
[#186](https://github.com/denoland/celld/issues/186#issuecomment-5541863958)
names v0.4.1 after the crypto metadata change had landed. There is no equivalent
commitment on #174 or #177; that is not evidence of inactivity.

## Why GitHub cannot expose an “unstable branch” here

As checked on 8 September:

- the repository default branch is `main`; its visible tip is
  [`10cb1303`](https://github.com/denoland/celld/commit/10cb1303dac710dcb3b557e318e08c855261f68b),
  the v0.4.1 release commit;
- GitHub Discussions are disabled, and the REST pull-request listing returns
  HTTP 404 rather than an inspectable development queue; and
- the [contribution policy](https://github.com/denoland/celld#contributions)
  says pull requests are disabled and asks contributors to email
  `git format-patch` attachments to Ryan.

The [release workflow](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/.github/workflows/release.yml)
creates a draft release from a temporary candidate before human verification
and publication. Candidate activity is not the same thing as a durable,
fetchable public branch or an announced API contract. Therefore we cannot
infer an availability date from an alleged “unstable branch” without a concrete
binary, candidate URL, or maintainer statement.

## Planning recommendation for V4

| V4 dependency                                               | Best current planning status | Reason                                                |
| ----------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| Named SQLite facets                                         | Available now in v0.4.1      | Released and locally demonstrated.                    |
| Server-side streaming response lifecycle                    | Available in v0.4.0+         | #159 closed as shipped; test V4's path independently. |
| Cross-isolate handles/callbacks/pipelining/stream transport | Blocked upstream, no ETA     | #174 open without public maintainer response.         |
| Loader `globalOutbound` or capability-valued `env.ITX`      | Blocked upstream, no ETA     | #177 open without public maintainer response.         |
| WebCrypto Ed25519 `subtle.verify`                           | Blocked upstream, no ETA     | No public issue/release/comment promises it.          |

The practical posture is to keep the celld runner and tests ready for a
specific candidate binary, retain passing facets/compiler coverage, and leave
the blocked tests visible rather than coding compatibility shims that erase
the intended capability boundary. Re-evaluate immediately when an upstream
binary or public commit is supplied; do not turn the current lack of dates into
a guessed roadmap.

## Scope and source method

This review used only first-party celld GitHub releases, issues, issue
timelines/comments, repository metadata, and source links on 8 September 2026.
“No public ETA” means no such item was found in those primary sources. It does
not make a claim about private development, email discussions, or an
unpublished candidate. The source-level compatibility audit follows this note.

## Source audit: what kind of work is actually missing?

The existing clone was refreshed in the usual location,
`/Users/jonastemplestein/src/github.com/denoland/celld`, without changing its
working tree. It is a full, non-shallow clone. The advertised remote currently
has only `main`; all eight commits on its history are release snapshots. The
latest visible [candidate build](https://github.com/denoland/celld/actions/runs/33977093881)
is the already-released v0.4.1 SHA, not a newer build containing our missing APIs.
The workflow allows two-stage publication; it does not provide a continuously
published unstable channel.

### Runtime architecture explains why facets alone do not unblock V4

Celld embeds V8 directly and implements its own Workers-compatible API. It does
not merely wrap workerd or run V4 in the Deno runtime. The
[runtime adapter](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8)
connects V8 to storage and host services; the
[JS harness](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2020)
implements the facet and capability-facing objects. Separately,
[`crates/logic`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/logic/lib.rs#L3)
models coordination as events and effects. Progress on replication and placement
does not automatically supply missing JavaScript API contracts.

Facet calls reuse the loaded-worker RPC transport. That transport explicitly
rejects awaitable properties and multi-segment calls. General RPC stub revival
consults an isolate-local registry; a foreign isolate's marker becomes a rejecting
stub. Loader bindings separately pass through JSON serialization. Consequently,
V4 needs a real cross-isolate capability transport with callback routing,
ownership/lifetime behavior and binding injection—not just another facet method.
This is an architectural assessment, not a prediction of engineering time.
([facet dispatch](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2085),
[stub revival](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3542),
[loader env](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8599))

### Crypto and module parsing are narrower compatibility defects

Ed25519 verification already exists in the
[Rust implementation](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/crypto.rs#L640)
and is connected to
[`node:crypto.verify`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/node_crypto.js#L1012).
However, [Web Crypto's verify dispatch](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/crypto.js#L563)
does not include Ed25519. V4 also encountered raw-key-import and unpadded-base64
failures before reaching that dispatch. The earlier source-only inference that
the backend primitive proved Web Crypto compatibility was wrong; the
[executed V4 results](../packages/v4/project-worker/docs/celld.md) take precedence.
This suggests a focused API-conformance patch, not a new cryptographic engine;
it does not establish that such a patch is scheduled or safe without tests.

Likewise, the [module import scanner](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/modules.rs#L76)
requires whitespace after `import`, while V4's minified processor SDK can use
`import{...}`. That is a concrete parser/registration defect to reproduce and
fix independently of cross-isolate RPC. Named-class-only module startup also
failed in V4's earlier run. No arrival date was found for either correction.

### How to obtain a useful upstream answer

The narrow questions to ask are whether #174 and #177 target a particular
release, whether there is a candidate binary that implements them, and which
capability/lifetime semantics it supports. Separately, small reproductions for
Web Crypto and minified imports fit the project's focused-patch contribution
policy. No issue, email, patch submission or GitHub mutation was made during
this research.

The project [describes differential workerd/celld testing](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/testing.md),
but relevant conformance suites are included from external environment-specified
files under an [internal test flag](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/lib.rs#L299),
not supplied as the full corpus in this public checkout. We should retain V4's
own reproducible tests as the acceptance gate, even after an upstream announcement.

# Lens: content-addressed code — the Unison/Nix/Git reading of iterate

_A scholar's lens on the 1M-repo update problem (notebook §6.10, options A/B/C/D)
and on what a "repo" and a "deploy" even are in iterate. Written to be argued
WITH, then argued AGAINST — the last section attacks the recommendation as hard
as the first three build it. Code claims checked against branch `simplification`._

---

## 0. Why this lens exists

The notebook's hardest unsolved problem is stated plainly in §6.10: **we cannot
rebase behavior into 1M project repos every time the platform changes, and it is
not obvious we can avoid it.** The option space (A platform-side / B vendored
code / C pointers+lock/Organism Image / D real deploys) is laid out but left
unadjudicated on purpose.

Every one of those options is secretly a *naming* question — "when a project
runs behavior X, what does the name X resolve to, and who gets to re-point it?"
That is precisely the question content-addressed code systems exist to answer.
Unison, Nix, Git, and IPFS are four different answers to "separate the *content*
of code from the *name* of code, so that updating a name never mutates content
and never forces a rebase." iterate has already, without quite naming it, built
the load-bearing half of this (`build-key.ts`, the artifact store). This lens
finishes the thought.

The claim in one sentence: **iterate's "repo" is drifting toward a
content-addressed namespace with git bolted on the outside for humans — and the
fleet-update problem dissolves the moment we admit it, but the adoption tax of
admitting it out loud could kill the product.**

---

## 1. The Unison insight, applied to iterate

### 1.1 What Unison actually does (mechanics, made precise)

Unison stores code not as text files but as an **append-only database of
immutable definitions, each addressed by the hash of its own syntax tree**
(after the tree is normalized: local variable names stripped, dependencies
replaced by *their* hashes). A function `factorial` is not a line in a file; it
is a value with a hash like `#a84f...`. That hash is computed over the AST with
every referenced definition substituted by its hash, recursively — so the hash
transitively pins the *entire* dependency closure. Two definitions with the same
behavior and the same dependencies have the same hash, everywhere, forever.

Four consequences fall straight out, and each one maps onto an iterate pain:

1. **There are no "versions of a file."** A definition never changes; you add a
   *new* definition with a *new* hash. `factorial` v2 is `#b91c...`, a different
   value coexisting with `#a84f...`. Nothing was mutated, so nothing can conflict.
2. **There is no build.** The hash IS the compiled identity; the codebase is
   already a graph of typed, hashed terms. "Compiling" is looking up hashes.
3. **There are no dependency conflicts.** A depends on `#a84f`, B depends on
   `#b91c`; both hashes exist in the database simultaneously. "Diamond
   dependency hell" is impossible because the thing depended on is a hash, not a
   range that must be reconciled to one winner.
4. **Names are a separate, mutable layer.** A *namespace* is a mapping from
   human names (`math.factorial`) to hashes. Updating a project means: publish
   new hashes, then re-point names. `git pull`/rebase has no analogue —
   **there is nothing to rebase, because names point at content and content is
   immutable.** Unison even calls the update operation `patch`: a set of
   `oldHash -> newHash` replacements that a consumer *chooses* to apply to their
   own name-bindings.

The rename problem — the classic reason you can't refactor a large codebase
cheaply — evaporates: renaming `factorial` to `fact` changes a name-binding, not
the hash, so no dependent has to recompile or even notice.

### 1.2 The mapping onto iterate

Now read the notebook's ontology (§5.10, §6.9) through this. iterate's kernel
proposes these package-able units: **processors** (contract + reduce +
processEvent), **event schemas** (owned by a URI namespace, §6.5), **capability
mounts** (a quoted expression + types + docs, §6.7), and **mini-apps** (a worker
entrypoint served at a hostname). These are exactly the things Unison would
store as hashed definitions.

So the reframe: **a "config repo" is not a git repo of source. It is a
NAMESPACE of content-addressed definitions.** Concretely:

- A processor definition is a value; its hash pins its contract, its reduce/
  processEvent code, AND (transitively) the `iterate/sdk` version it was built
  against and every helper it imports. Two projects that installed
  `@iterate/tasks@3` from npm reference the *same processor hash* — not two
  copies, one hash.
- An event schema is a value; its hash is the schema-authority for that event
  type. `events.iterate.com/agents/message-received` is a *name* that resolves
  to a schema hash. Changing the schema mints a new hash; old journals still
  name the old hash and replay against it exactly (this is §7.2's "stamp events
  with the config commit," except the stamp is a hash, which makes replay
  across self-modification *exact*, not approximate — §3 below).
- A capability mount is *already* a quoted expression (`ItxExpression`), which
  §6.7 wants to make the universal grammar. A quoted expression bound to its
  argument closure is a content-addressable value: hash it and you have a
  stable, grantable, revocable capability identity.
- A mini-app is a worker build. iterate **already content-addresses these**
  (next section).

"Update 1M projects" then means: **publish new hashes; let each project's
name-bindings resolve.** Nobody rebases, because a project's repo does not
*contain* the platform's processor code — it contains a *name-binding* that
resolves to a hash the project chose (or chose to follow a channel that
re-points it). This is option C from §6.10, but derived from first principles
rather than borrowed from apt/npm: the "Organism Image" IS a Unison namespace
snapshot.

### 1.3 How close is iterate already? The `build-key.ts` delta

This is the striking part: **iterate is already a content-addressed build
system for one of its four unit types (mini-apps/workers), and the code proves
the worldview is native, not foreign.**

Read `build-key.ts` and `artifact-store.ts` as a content-addressed scholar:

- `workerBuildKey()` computes `stableSha256` over `{ source, options,
  compatibilityDate/Flags, bundlerVersion, artifactSchemaVersion }`
  (`build-key.ts:66-76`). That is a **transitive content hash of a build's
  entire identity** — the exact Nix/Unison move. The bundler version and schema
  version are in the hash precisely so that "upgrading the toolchain invalidates
  cached artifacts instead of serving output from an older toolchain"
  (`build-key.ts:5-16`). That sentence is a Nix derivation-hash argument, written
  in iterate's own comments.
- `ResolvedWorkerFileSource` carries a `contentHash` that "replaces the commit
  oid in the build key, so repos with identical content — every freshly seeded
  project repo — share one artifact instead of each paying a bundler run"
  (`build-key.ts:18-33`). **This is the 1M-repo insight already implemented, at
  the artifact layer:** a million identical seeded repos are ONE hash and ONE
  artifact. `repoContentHash()` is `stableSha256({ files, type: "repo-content"})`
  (`repo-durable-object.ts:1375-1377`) — a whole-checkout Merkle-ish identity.
- `artifact-store.ts` stores artifacts "content-addressed and immutable: each
  key is written once and read by exact key" with TTL-based expiry and no
  cleanup worker (`artifact-store.ts:1-16`). That is a content-addressed store
  with GC-by-expiry — a poor man's Nix store.
- `resolveFileSource()` (`worker-loader.ts:253-292`) does the **name→content
  resolution**: a branch ref is "deliberately late-bound … names 'the worker at
  this repo path', not a frozen commit," resolved through the repo's durable
  head cache to a `{commitOid, contentHash}`. A pinned `commitOid` skips the
  cache. **This is exactly Unison's name layer vs. hash layer** — a branch is a
  mutable name-binding; a pinned commit is a frozen hash-reference. iterate
  built both resolution modes already.
- Even `iterate/sdk` reaches userspace **by name-binding, not by vendoring**:
  it is injected as a virtual module at build time
  (`iterate-sdk-virtual-module.codegen.cjs`), "build-key-coherent" — its version
  participates in the hash. The kernel does not copy itself into a million
  repos; it is a hash that a build resolves against.

**The delta between iterate-today and Unison-for-iterate is therefore narrow
and nameable:**

| Unison property | iterate today | delta to close |
|---|---|---|
| Definitions hashed by transitive content | Worker BUILDS hashed transitively | Extend hashing from "the whole worker build" down to individual **processors, schemas, mounts** as first-class hashed values |
| Names resolve to hashes; names are mutable, content isn't | Branch→head cache does exactly this for repos | Make the resolution unit a *definition* not a *whole checkout*; make the name layer a **journal** (name-binding = event) |
| Update = publish hash + re-point name (no rebase) | Fresh-seed dedupe proves it for identical content; DIVERGED repos still rebase | The diverged case: only *user-authored* names diverge; *platform* names are followed channels — separate the two |
| Content store, GC by reachability/expiry | KV artifact store, GC by TTL | Fine as-is; maybe reachability GC later |

The headline: **iterate did the hard, unglamorous 60% (a real content-addressed
build cache with name-vs-hash resolution) and is one conceptual step from the
part that solves the fleet problem** — making the *unit* of content-addressing
the definition rather than the whole checkout, and making the *name layer* a
journal of bindings rather than a git branch.

---

## 2. The fleet update problem through this lens

### 2.1 Unison namespace vs. codex's "Organism Image": same idea, one crucial difference

Codex's "Organism Image" (Appendix C §4) is: the config repo + installed
packages **compile into one content-addressed image** containing the event-owner
table, contract/schema revisions, processor artifacts, subscription graph,
capability grants, egress requirements, secret refs, timers, routes, package
entitlement proofs, and the migration graph. Linking *fails before execution* on
namespace collisions, missing supervisors, unresolved versions, invalid grants,
or cyclic activation. Activation is one event: `project/image-activated
{ previousHash, imageHash }`. Old images remain replayable forever.

**Is this the Unison idea? Almost exactly — with one telling difference.**

- The **image hash** is a Merkle root over the whole activation graph. That is
  Unison's *namespace hash* (Unison hashes namespaces too, not just terms). Same
  move.
- "Old images remain replayable forever" is Unison's *immutable definitions
  coexist* property, lifted to the whole organism. Same move.
- Linking-fails-before-execution is Unison's *typed, total codebase* guarantee:
  in Unison you cannot save a definition that doesn't typecheck against the
  hashes it references; the codebase is always coherent. Codex's linker is that
  guarantee at organism scale. Same move.

**The difference is the lockfile.** This is the Nix-vs-Unison split, and it is
the whole design decision:

- **Unison has no lockfile.** Names resolve *directly* to hashes. There is no
  separate "resolved" artifact because there is nothing to resolve — a name IS a
  pointer to a hash, stored in the namespace. Update = edit the namespace
  (re-point names). The "lock" and the "manifest" are the same object: the
  namespace.
- **Nix has a lock** (`flake.lock`). The manifest (`flake.nix`) says "I want
  nixpkgs, roughly this channel"; the lock pins the *exact* input hashes that a
  build resolved to. The manifest is human intent (ranges, channels); the lock
  is machine-resolved identity (exact hashes). You commit both; `nix flake
  update` re-resolves the lock without touching the manifest.

Codex's Organism Image is **Nix-shaped**: a manifest (config repo: "install
`@iterate/tasks@^3`, follow `latest-stable`") that *links* into a pinned image
(the lock: exact hashes of every processor/schema/mount). The `project/
image-activated { imageHash }` event is the committed lockfile.

### 2.2 Which is right for iterate?

**Nix-shaped (codex's image) is right, and Unison-pure is wrong — for a specific
iterate reason.** In Unison the namespace-that-is-the-lock lives in the
developer's codebase and is edited by a human running `update`. iterate's
"developer" is (a) frequently an LLM agent and (b) frequently *the entity itself*
self-modifying. You want a **human/agent-legible manifest of intent** (channels,
ranges, "follow platform stable") that is SEPARATE from the **machine-resolved
pinned lock**, because:

- The manifest is what self-modification edits and what a human reviews ("this
  entity installed the tasks package and follows platform stable"). It is small,
  diffable, PR-able.
- The lock (image hash) is what *replay* and *supervision* need to be exact. An
  event stamped with `imageHash` replays under precisely the code that produced
  it. You never ask a human to read the lock.
- The **channel** is the join between them, and here is the stream twist §6.10
  already spotted: **the default channel is itself a journal.** "Follow
  `latest-stable`" means "my lock re-resolves when I next link, picking up
  whatever hash `latest-stable` now names." A platform update is an *append to
  the channel journal* that a project's manifest *chooses to follow*. Pinned
  projects set their manifest to an exact hash and ignore the channel.

So: **manifest (intent, journal of `configured` events) + lock (imageHash,
journal of `image-activated` events) + channel (a journal the manifest follows).
Three journals, one namespace resolution.** This is Nix's three objects
(`flake.nix` / `flake.lock` / the channel) re-expressed as event streams — which
is the *most* iterate-native thing imaginable, because iterate's whole thesis is
"everything is a journal."

### 2.3 The security-patch-vs-pinned tension — the exact mechanism

This is the case that decides everything, and content-addressing gives you
*both* answers cleanly. Two projects:

- **Project P** follows `platform/stable`. A CVE lands in the default agent
  processor. The platform publishes a new processor hash and re-points the
  `platform/stable` channel to it (an append to the channel journal).
- **Project Q** pinned the old processor hash in its manifest (it forked and
  customized, or explicitly froze for stability).

**Force-update (P):** P's manifest says "follow stable." On P's next *link*
(triggered by any config change, OR by a platform-issued "relink-now" nudge —
which is itself just a broadcast cross-post to all wake streams, §1.1), P
re-resolves `platform/stable` → new hash, produces a new image, appends
`project/image-activated { previousHash, newHash }`. **Nobody rebased P's repo.**
P's repo still says "follow stable"; only the *lock* moved. The CVE is patched by
a channel re-point that P's own name-binding chose to follow.

**Immutability (Q):** Q pinned the hash. The channel re-point does not touch Q,
because Q's manifest names a hash, not the channel. Q keeps running the old
processor. **This is correct and desirable** — Q made an informed choice to
freeze. Content-addressing is the only model where "patch everyone" and "respect
the pin" are the *same mechanism* (name resolution) rather than two conflicting
policies fighting over one mutable file.

**The critical security nuance content-addressing forces you to confront:** what
if the CVE is so bad you must patch Q *against its will*? Content-addressing says
you *can't* silently — Q's lock names a specific hash and immutability is the
whole point. What you CAN do is what apt/npm do: **the channel can carry a
"yanked/revoked" fact.** Publish `hash #old REVOKED` on a security channel that
even pinned projects subscribe to for *advisories*. Then the kernel's
non-overridable veto (§6.3's "what stays kernel": billing, safety ceilings) can
*refuse to activate* a revoked hash — the kernel declines to link an image
containing a known-poisoned definition, forcing Q to relink against a safe hash
or explicitly acknowledge the risk. **This is exactly how Nix handles
`insecure` packages** (`permittedInsecurePackages` — you must name the exact
poisoned hash to opt back in). The pin is honored *by default* and overridden
*only* by a loud, kernel-level, per-hash acknowledgment. That is the right
security posture and content-addressing makes it precise instead of a policy
argument.

---

## 3. What deletes

If code is content-addressed values resolved by name-bindings that are
themselves events, a surprising amount of `apps/os` machinery loses its reason to
exist. Going through it concretely:

### 3.1 "Build as a step" and the builder sidecar shrink toward lookup

Today a build is a *procedure* run by a builder sidecar (`builder-entrypoint.ts`,
declared temporary by `worker-topology.md`), producing an artifact filed under a
key. In the fully content-addressed reading, **the hash exists before the build
runs** — the build key is computed from inputs, the artifact is a cache under it.
This is already true (`build-key.ts`). The deletion the lens sanctions: stop
thinking of "build" as a lifecycle step with states (requested/building/failed)
and start thinking of it as **memoized resolution** — `resolve(hash) -> artifact
| (compute-and-cache)`. The `building` in-flight markers, the building-page
refresh loop, the `worker/build-requested` saga all collapse into "cache miss →
fill." The builder becomes a pure function behind a content-addressed memo table,
not a supervised job. (It doesn't vanish — someone runs `esbuild` — but it stops
being an *event-sourced obligation* and becomes an implementation detail of
`get(hash)`.)

### 3.2 Rebasing, and "deploys" for mini-apps, vanish outright

This is the fleet win. There is no rebase because there is no shared mutable
file that platform and user both write. Platform behavior is a *name the project
follows*; user behavior is a *name the project owns*; they never collide, so
there is nothing to three-way-merge. And a mini-app "deploy" — today a build +
ref update + rollout — becomes **re-pointing one name-binding to a new hash**, an
append. `envs.ts` as "a map of deployments" weakens toward "a set of channels and
replay targets" (§7.2's exact prediction). "Deploy" survives only as a word for
"the platform published new hashes and re-pointed a channel."

### 3.3 Version-skew during replay disappears — and this is the deepest win

Today, replaying a journal across self-modification is *approximate*: the code
has changed since the events were written, so "fold the journal" runs old events
through new code. §7.2 proposes fixing this by stamping every event with the
config-repo commit that processed it. **Content-addressing makes that stamp a
hash and makes the replay EXACT.** Every event carries `imageHash` (codex's
"every subsequent event records the image under which it was observed and the
artifact that produced it," App. C §4). Replay resolves each event's `imageHash`
to the exact processor/schema hashes and folds *under the code as it was at that
moment*. This is Unison's superpower — old definitions coexist with new, so you
can always run the exact historical version — applied to iterate's journal. It
makes three notebook fantasies suddenly buildable:

- **§7.2 "the entity is a file":** tar (repo-manifest + journal), replay
  anywhere a Worker Loader runs, bit-identical, because every event names its
  code. The "config-repo commit stamp" the notebook asks for is the `imageHash`.
- **§7.3 "shadow selves":** replay the last 10k events under a *candidate* image
  hash, effects jailed, diff against lived history. Deterministic because both
  incumbent and candidate are pinned hashes.
- **§7.5 "time is a place" (`itx.at(offset)`):** the entity at any past offset is
  well-defined precisely because you can resolve the image hash in force then.

Version-skew rebuild logic in `StreamDurableObject` (the `CORE_STATE_VERSION`
bump that discards checkpoints, §5.3) becomes principled: a checkpoint is valid
iff it was folded under a compatible image hash; otherwise re-fold from a
snapshot. No guessing.

### 3.4 The migration/upcaster graph becomes hash-keyed and total

Event schema migrations today are a social discipline. In the content-addressed
world, a schema is a hash and an upcaster is `hash_old -> hash_new` — **exactly
Unison's `patch`**. The migration graph codex wants in the image (App. C §4) is a
set of hash-to-hash rewrites, and "does every old schema have a path to the
current one" is a *reachability check on a hash graph*, mechanically verifiable
at link time. No orphaned schema versions, no "did we remember to write the
migration."

### 3.5 What does NOT delete (honesty)

- The journal, append, fold, delivery, supervision — the kernel (§6.8) is
  untouched; content-addressing is about *how code is named and resolved*, not
  how events flow.
- Secrets substitution, egress, auth — orthogonal.
- The *human/agent* editing surface. Someone still authors the manifest and the
  user-owned definitions. Content-addressing does not remove the need to write
  code; it removes the need to *reconcile* code across a fleet.

---

## 4. The hard part — why this is a bad idea (argued as aggressively as I can)

I have spent three sections making content-addressing look inevitable. It is now
my job to try to kill it. Content-addressed code systems have a **brutal**
adoption record, and the reasons are not incidental — they are structural, and
several of them hit iterate at its most sensitive point: *the primary user is an
LLM agent* (§1.1).

### 4.1 The graveyard is real and the cause is legible

Unison is, by common consent, one of the most beautiful language designs of the
last twenty years. **Almost nobody uses it.** Nix is extraordinarily powerful and
is a byword for *hostility* — "Nix is great, the learning curve is a cliff" is a
meme because it is true. IPFS promised content-addressed everything and mostly
delivered dead gateways and a token. Git — the *one* content-addressed system
that won — won **precisely because nobody has to know it is content-addressed.**
Git's blobs/trees/commits are a Merkle DAG, but 99% of users think in files,
branches, and `git pull`, and the plumbing (`git cat-file`, hashes) is hidden
behind porcelain. **The lesson of the entire graveyard is: content-addressing
succeeds only when it is invisible.** Any design that makes iterate developers
(or agents) *think in hashes and namespaces instead of files and folders* is
betting against every data point we have.

### 4.2 "Where is my code? I just want a file" — the developer revolt

Unison's single most-cited friction: **there are no files.** Your code lives in
a database; you edit through a scratch file that Unison slurps and hashes; `ls`
shows a namespace, not a directory. Programmers hate this with a passion that
surprises Unison's own creators. The instinct "let me just open the file and see
the code" is not a skill deficit to be trained away — it is the substrate of
forty years of tooling, muscle memory, and mental models. iterate's whole
config-repo pitch (§6.3) is *"the configuration IS a worker.ts file"* — a FILE,
deliberately, because that is legible. A content-addressed namespace directly
contradicts the thing the notebook found most compelling about the config repo.
If we make the repo "not really files, actually a namespace of hashes," we throw
away the single most intuitive idea in the whole vision.

### 4.3 The killer: LLM agents are trained on files-and-folders, not namespaces

This is the objection I would lead with if I wanted to stop this proposal, and
it is close to decisive. **The primary user of iterate is an LLM agent** (§1.1),
and every frontier coding agent — Claude, codex, the ones §6.1 wants to host as
processors — was trained on an internet of *files, folders, git, and package.json*.
Their entire prior is "read the file, edit the file, commit the file." They are
extraordinarily good at git-shaped workflows and *bad, untested, and
out-of-distribution* at "publish a definition to a content-addressed namespace
and re-point a name-binding." Unison's own tiny community includes ~zero LLM
tooling. If iterate's substrate is a content-addressed namespace, **we are asking
the platform's primary user to operate in the one paradigm it has the least
training data for** — and iterate cannot fix that, because it does not train the
models. Every agent interaction becomes a fight against the model's file-shaped
instincts. This alone could make the whole thing feel broken to the exact user it
is built for.

### 4.4 The ergonomic losses are real and beloved

- **`git blame` dies.** In a content-addressed namespace "who changed this and
  why" is a namespace-history query, not `blame`. Blame is one of the most-used
  debugging tools in existence. Unison has nothing as good.
- **PR review dies, or mutates into something unfamiliar.** Code review is
  *diffing files*. A namespace update is a set of `oldHash -> newHash`
  re-pointings; the "diff" is over an AST database, not a unified text diff.
  GitHub, the review UI everyone knows, the whole social protocol of "request
  changes on line 42" — all file-and-line shaped. iterate's own PR-agent
  (`pr-agent-processor-implementation.ts`) is built on GitHub PRs. Content-
  addressing fights that.
- **grep dies at the boundary.** "Where is this string" across a hash namespace
  is not `rg`. The notebook's own culture (`grep-at-edit-time is the
  discipline`, per memory) is file-shaped.

### 4.5 Storage: never deleting a hash is a cost, not a freebie

"Old images remain replayable forever" (App. C §4) sounds free and is not. A
million projects, each self-modifying, each minting new definition hashes on
every change, with the kernel obligated to retain every hash any journal event
references (because replay must resolve it) — that is a **content-addressed store
that can only grow.** Nix stores are famously enormous; `/nix/store` eating disk
is a rite of passage. iterate's artifact store today survives on *TTL expiry*
(`artifact-store.ts:16`) — "expiry only costs a rebuild." But that only works
because a build is *reproducible from inputs still in the repo*. If the "input"
(an old definition hash) is ITSELF only in the content store, TTL expiry breaks
replay: you evict `#a84f`, and now a 2-year-old event that names `#a84f` can
never be replayed exactly. **Content-addressing for replay-exactness and
GC-by-expiry are in direct tension.** You either pay unbounded storage or you
give up the exact-replay superpower that was §3.3's whole justification. Nobody
in the graveyard solved this cheaply.

### 4.6 The debugging unfamiliarity compounds

When a Nix build fails, the error is a wall of hashes and derivation paths, and
diagnosing it requires understanding the content-addressed model. When an agent's
processor misbehaves in iterate-today, you read `worker.ts`. In the namespace
world you resolve a hash to find the code, which resolves to more hashes. Every
debugging session starts with a resolution step. The notebook's own debugging
docs (`debugging-deployed-os-workers.md`) assume you can *read the deployed
code*. Content-addressing adds an indirection to the most stressful moment in the
lifecycle.

### 4.7 The honest verdict on my own recommendation

The pure Unison/namespace reading — "the repo is not files, it is a
content-addressed namespace" — **would probably doom iterate**, for §4.3 above
all: it points the platform's primary user (an LLM trained on files) at the one
paradigm it is worst at, and it does so to solve a problem (fleet update) that
has cheaper file-compatible solutions. I do not recommend it.

---

## 5. The hybrid — and whether it's the best of both or the worst

The obvious escape is: **git-on-the-outside for humans and agents;
content-addressed-on-the-inside for the platform.** Get the fleet-update win
without the adoption tax. Is that coherent, or the worst of both worlds?

### 5.1 The good news: iterate is ALREADY this hybrid, and it works

Look again at what the code actually does:

- **Outside:** a real git repo, real `worker.ts` files, real branches, GitHub
  links, PRs, `git blame`. Agents and humans see files. (`config-repo-template/`,
  `github-link.ts`, `pr-agent`.)
- **Inside:** `build-key.ts` content-addresses the *build*; `contentHash` dedupes
  identical checkouts to one artifact; `resolveFileSource` resolves a mutable
  branch-name to an immutable content identity before pinning; `iterate/sdk` is a
  hashed virtual module, not vendored source.

**The seam is `resolveFileSource` (`worker-loader.ts:275-292`): "branch refs are
deliberately late-bound … names 'the worker at this repo path', not a frozen
commit."** That single function IS the git-outside/hash-inside boundary. A human
edits a file on a branch (git-shaped, familiar); the platform resolves that
branch to a content hash and everything downstream — caching, dedupe,
build-identity — is content-addressed. **This is precisely Git's own winning
trick** (§4.1): content-addressing that nobody has to see. iterate reinvented
Git's porcelain/plumbing split for builds and it is the least-controversial part
of the system.

So the hybrid is not hypothetical; it is the current architecture, applied to one
unit type (whole-worker builds). The question is only: **how far up the ontology
should the content-addressed-inside layer climb** — from "whole worker builds"
toward "individual processors, schemas, mounts"?

### 5.2 The hybrid that gets the fleet win

The minimum climb that captures §2's fleet-update mechanism without touching the
git-outside experience:

1. **Keep files, git, PRs, blame, grep on the outside. Non-negotiable, for §4.**
   The manifest (channels, package versions, overrides) is a plain, diffable,
   PR-able file — `iterate.json`-shaped, the thing an agent edits and a human
   reviews. This is the Nix `flake.nix` / npm `package.json` — a *file* every
   agent already understands.
2. **Content-address the resolved lock on the inside**, as a journal fact.
   Linking the manifest produces an `imageHash` (codex's image), appended as
   `project/image-activated`. Humans/agents never read it; replay and
   supervision do.
3. **Make the platform's default behavior a followed channel, not vendored
   code.** The seeded `worker.ts` stops *containing* the agent processor's guts;
   it *names* `@iterate/agent` following `platform/stable`. A platform update
   re-points the channel; followers relink; pinners don't. **No repo is
   rebased** — the file that says "follow stable" is unchanged; only the lock
   moved (§2.3).
4. **Stamp events with `imageHash`** so replay is exact (§3.3) — the one piece
   that requires content-addressing to reach *inside* the journal.

This gets: fleet updates by channel re-point (the whole prize), exact replay,
shadow selves, security-patch-vs-pin, "the entity is a file" portability — while
the human/agent experience stays files-and-git. It is Git's plumbing/porcelain
split, extended one level: **porcelain = files + manifest + branches; plumbing =
content-addressed lock + image hashes + channel journals.**

### 5.3 Why this might still be the WORST of both worlds

I promised to attack even the hybrid. The strongest case that it is the worst of
both:

- **Two mental models, and the seam leaks.** Every hybrid has a boundary where
  the two models meet, and boundaries leak under stress. When a build behaves
  differently than the file suggests (because the *content hash* resolved to a
  cached artifact from a different-but-content-identical checkout, or because a
  channel re-pointed under you), the developer/agent is suddenly forced to
  understand the plumbing they were promised they'd never see. This *already
  happens* in iterate: the `build-key.ts` comment about "npm ranges re-resolve at
  build time, so a rebuild of the same key can pick newer dependency versions"
  (`artifact-store.ts:13-16`) is a leak — the content hash claims immutability
  the npm resolution quietly breaks. Nix fixed this only by going *fully*
  hermetic (pinning npm too), which is the hostile part. Half-hybrid = the seam
  leaks at exactly the confusing moments.
- **You pay both storage bills.** git history (for humans) AND the content store
  (for replay). Neither GCs cleanly (§4.5).
- **"Follow a channel" reintroduces the thing you fled.** The moment a project
  follows `platform/stable`, a platform change *does* change the project's
  behavior without the project's repo changing — which is **spooky action at a
  distance**, the exact complaint people have about auto-updating dependencies.
  You traded "rebase 1M repos" (visible, painful, owned) for "1M repos silently
  change behavior when a channel moves" (invisible, painful, owned by nobody). A
  project debugging a regression now has to ask "did *my* code change, or did a
  channel move under me?" — the §5.3 leak, at fleet scale. This is a *real*
  regression in debuggability versus option A (platform-side behavior, one
  deploy, one place to look).

### 5.4 My actual recommendation

The hybrid is the right answer, but it must be drawn conservatively, and I'd rank
it against the notebook's options honestly:

- **The content-addressed lens most strongly VALIDATES option C** (pointers +
  lock / Organism Image) as *the only option that solves fleet update without
  rebasing* — and clarifies that C is really "Nix flakes as journals," which is
  deeply iterate-native.
- **But the lens also validates a hard limit: content-address only DOWN to the
  unit that must be shared or replayed exactly** — the resolved lock, the image
  hash, the artifact — **and NO FURTHER UP than the files humans/agents touch.**
  Never make the *authoring surface* content-addressed. Unison's fatal error was
  content-addressing the thing the human edits. Git's victory was content-
  addressing everything *except* that.
- **The `imageHash`-per-event stamp is worth it** even at storage cost, because
  exact replay is the enabling primitive for the notebook's three best ideas
  (§7.2/7.3/7.5) — but pay for it with **checkpoint snapshots + bounded retention
  of images actually referenced by un-compacted journal ranges**, not unbounded
  retention. Accept that very old exact-replay may require a rebuild-from-manifest
  (approximate) rather than a hash lookup (exact) — a graceful degradation Nix's
  TTL model already lives with.
- **The channel-follow "spooky action" (§5.3) is the real cost and must be made
  loud:** a channel re-point that changes a project's behavior MUST land as a
  visible `image-activated { previousHash, newHash, whatChanged }` fact the
  dashboard folds and shows — the same "override must be loud" discipline §6.3
  already demands. If a channel can silently change behavior, you have rebuilt
  Windows Update; if every change is a visible, diffable, revertable journal
  fact, you have something *better* than a deploy: a fleet update with per-entity
  provenance and one-append rollback.

**The one-line verdict:** iterate should content-address the *lock and the
artifacts* (it already does, ~60%) and stamp events with the *image hash* — but
must keep the *authoring surface files-and-git forever*, because the primary user
is an LLM trained on files, and the graveyard of Unison/Nix/IPFS is the graveyard
of systems that made the human edit hashes. Git won by hiding the hashes; iterate
should too.

---

## 6. Appendix: the mechanics table (Unison / Nix / Git / iterate, side by side)

| Concept | Unison | Nix | Git | iterate today | iterate under this lens |
|---|---|---|---|---|---|
| Unit of content-addressing | a definition (AST, transitively hashed) | a derivation (build recipe closure) | blob/tree/commit | a **worker build** (`workerBuildKey`) | + processor / schema / mount definitions |
| Hash covers dependencies? | yes, transitively | yes, transitively | yes (tree includes children) | yes (source+bundler+opts in key) | yes, extended to defs |
| Name → content layer | namespace (mutable) | attr paths + channels | refs/branches (mutable) | branch→head cache (`resolveFileSource`) | name-bindings as **journal events** |
| Manifest vs. lock | fused (namespace) | split (`flake.nix`/`flake.lock`) | none (branch is both) | implicit (repo + resolved source) | **split**: manifest file + `imageHash` event |
| Update mechanism | `patch` (oldHash→newHash) | re-resolve lock / channel bump | pull/rebase (mutates!) | rebuild key on new content | **re-point channel; relink; append** |
| Rebase needed to update? | **no** | **no** | **YES** | no for identical content; yes for diverged | **no** (platform names followed, not vendored) |
| Old versions coexist? | yes (immutable defs) | yes (store paths) | yes (objects) | via TTL cache | yes, until retention/GC |
| GC model | reachability | reachability roots | reachability (gc) | **TTL expiry** | reachability of referenced image hashes |
| Human edits… | a scratch namespace (no files!) | `.nix` files | files | **files** | files + a manifest (**keep this**) |
| Won adoption? | ~no | powerful, hostile | **yes (hides the hashing)** | — | only if it hides the hashing (§5) |

The whole essay in one row: **Git won by content-addressing everything except
the file the human edits. iterate's fleet-update win is real and comes from
option C = Nix-flakes-as-journals; the trap is Unison's — do not content-address
the authoring surface.**

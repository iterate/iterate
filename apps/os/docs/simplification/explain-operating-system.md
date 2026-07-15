# iterate, explained as an operating system

_One of three parallel explanations of the same system. This one commits to a
single framing — **iterate is an operating system for intelligent entities** —
carries it precisely (syscalls, processes, the filesystem, the shell, ring 0 vs
userspace), and ends by attacking itself and the other two framings. Every
concept is glossed in one line a working programmer already owns; the private
vocabulary of the vision doc (organ, genome, attenuation, worldline) stays out
of the front door on purpose (§7.9)._

---

## 1. What it is, in one breath

**iterate is an operating system for intelligent entities: a tiny kernel that
runs confined code, journals every fact, and guards one door out — and above it
a small standard library and an open field of packages.**

Expanding that. A normal operating system gives programs three things they
cannot give themselves: a place to run (isolated processes), a place to keep
state (the filesystem), and controlled access to the outside world (system
calls guarded by the kernel). An iterate _project_ is one such machine, and the
program running on it is an intelligent entity — a family assistant, a
self-driving startup, anything that reacts to the world and acts back on it. The
kernel gives that entity a confined computer it cannot escape, a durable
append-only journal that _is_ its memory, and exactly one guarded exit for bytes
leaving the project. Everything a programmer would recognize as a "feature" —
agents, integrations, the scheduler, secrets management, the dashboard — is
_above_ the kernel: a standard library of deep first-party modules, or a package
anyone can write. The whole product today, `apps/os`, is one deployed Cloudflare
Worker holding every Durable Object class in one script (`src/worker.ts:1-11`);
the OS framing is the claim that inside that monolith there is a ~5,000-line
kernel wearing a 100,000-line coat, and that naming the kernel is how you take
the coat off.

The carrying sentence: **the kernel is exactly what userspace cannot express —
nothing more (§6.12).**

---

## 2. The three or four things you must know

### The three rings — ring 0 is small on purpose

> **Nothing that happens inside a project matters until bytes try to leave it.**

Like any OS, iterate has privilege rings. **Ring 0 (the kernel)** is the
non-negotiable constitutional machinery: identity and confinement, the journal,
obligation supervision, grant evaluation, secret substitution, the one egress
door, billing and recovery. **Ring 2 (the standard library)** is a _small_
number of deep, iterate-operated modules with overrideable policy and real
adapter seams: agents/conversations, repo/artifacts, secrets/egress,
scheduling. **Ring 3 (packages)** is the open field: vertical apps, alternative
UIs, narrow integrations, the operator's bespoke code, third-party processors.
The single most important design claim in this whole framing is _why not
everything is a package_ — see §5's fleet rule and §6 — but the ring structure
is the shape: a kernel you cannot replace, a std-lib iterate operates for you,
and packages you assemble yourself (§6.8, Appendix D §B).

### Two shells — you stand outside the machine, or you live inside it

An OS has a shell: a privileged place a human drives the machine from. iterate
has **two**, and they are different surfaces, not two skins on one page.
`os.iterate.com` is the **hypervisor / cloud console** — where you stand
_outside_ an entity and operate on it: auth, billing, raw journals, package
grants, pause, rollback, recovery. The entity's own domain (`hq.acme.com`,
`tasks.acme.com`) is where the entity _lives and faces the world_ — its apps,
its API, its public face. Codex's rule settles which is which: _if an operation
must still work when the project's code is broken, compromised, or deliberately
paused, it belongs at `os.iterate.com`_ (Appendix D §D). The console is
deliberately boring — "a cloud console, hypervisor panel, or corporate
registry: powerful, trusted, deliberately boring."

### The one door is the whole security surface

> **Internal fetch is free. External fetch is the entire security surface.**

A classic kernel mediates hundreds of syscalls. iterate's insight (Jonas,
§6.11) is that only one of them is a security boundary. Internal traffic —
`fetch("http://researcher.iterate/…")`, one entity messaging another, an agent
reading any internal state, running any code — is **harmless** and needs no
gate, because none of it can hurt anyone until bytes cross the project boundary.
There is exactly one place that happens: the egress door, where secret
placeholders get substituted for real material, allowlists apply, humans can be
asked, and everything is audited. The live egress entrypoint literally "sees
`getSecret(...)` placeholders, never material" (`src/domains/projects/egress.ts:5`).
Confinement stops being a thousand access checks scattered across 33
capabilities and becomes one gate on one verb.

### The fleet-update rule — publish a version, don't rebase a million repos

> **You don't rebase a laptop. You publish a package and it chooses to follow.**

This is the rule that keeps the std-lib from collapsing into either a frozen
monolith or a million-way merge. iterate expects on the order of **one million
projects**, most of them self-driving startups with their own domains. If the
platform vendored real behavior into each repo (option B), a single weekly
update would be **52 million repo mutations per year** — 1,000 failures per
release even at 99.9% success, and every diverged repo becomes a semantic merge
owned by nobody (Appendix D §A). The OS answer is the one every real OS already
uses: **channels and locks.** The config repo holds policy, package
ranges/pins, and custom code; the kernel resolves that into an immutable lock
and appends its activation; a platform update is a new default-package revision
that followers pick up on their next safe boundary and pinned projects don't.
"Do not build the one-million-repo rebaser. It buys less than a channel pointer"
(Appendix D §A verdict).

---

## 3. The ~5,000-line kernel, structured

> **The kernel is four verbs and six types. If a file doesn't implement one of
> them, it's a package (§6.9).**

The kernel is the syscall layer plus a confined-execution seed plus one egress
door plus obligation supervision. Told as modules, with honest line budgets
after the §5 collapses land (today → after):

| Ring-0 module | What it is, in one line | Today → after |
|---|---:|---:|
| **Confined-execution seed** | Run untrusted code, bound to a project identity, over durable named storage — the thing userspace cannot express because it _is_ what runs userspace (§6.12). | folded into auth+journal below |
| **Identity + confinement + session** | Which project owns this call; whose bytes are these; one project must never reach another (`src/domains/durable-object-names.ts`). | ~1,200 → ~700 |
| **Journal engine** | Append / read / fold an append-only log at a `(projectId, path)` — the only write in the system (`stream-durable-object.ts`). | ~1,300 → ~900 |
| **Processor engine + obligation supervision** | Fold + side effects + "durable job with an expiry and exactly-one terminal event" — the supervisor that revives crashed work (§5.4). | ~2,400 → ~1,400 |
| **Delivery** | At-least-once, stream-owned cursors, ack-advances-the-cursor, park-on-poison — the one subscription lane, server and browser (§5.5). | ~2,800 → ~800 |
| **Capability tree + expression evaluation** | The `itx` name tree; everything callable resolved by one longest-prefix walk; evaluation authority derives from _scope_, so it is itself a confinement mechanism (§5.8, §6.7). | ~1,700 → ~600 |
| **Egress door + secret cell/substitution** | The one exit: placeholder → material substitution outside userspace, allowlist, human approval, audit (`src/domains/projects/egress.ts`). | ~1,700 → ~700 |
| **Repo + build/load of the config worker** | The one blessed source of project code; the loader that boots userspace (the config `worker.ts`) — userspace cannot bootstrap itself (§5.6). | ~3,300 → ~900 |
| **Kernel total** | | **~14,400 → ~6,000** |

Not literally 5,000 — but the same order, honestly counted, and the residual is
real work not padding. The seed at the very center (`identity + confined code +
durable storage + one exit`, §6.12) is what stays kernel _by necessity_;
everything above it is kernel-by-choice at most.

**What is NOT in the 5k.** Ring 2 (the standard library) is iterate-operated but
_not_ counted here: agents (3.6k src lines today), integrations (5.5k),
scheduler (1.0k), secrets policy, email. These are deep modules with stable
seams, not kernel — the test is "could a third party build a credible
alternative through the public interfaces?" (§6.8). Ring 3 (packages) is
everything with a leaf shape: a tasks app, a CRM projection, one vendor's
machine-provider adapter, an alternative dashboard. Today's `rpc-targets.ts`
(6,014 lines, verified) and the generator pipeline (~5.3k) are neither kernel
nor std-lib — they are the coat: dispatch scaffolding that dissolves into a thin
authority layer plus std-lib modules once built-ins become ordinary described
mounts (§5.1).

---

## 4. The API as syscalls

A programmer meeting a new OS learns its syscalls first: `open`, `read`,
`write`, `fork`, `exec`. iterate's syscall set is smaller — **four verbs** —
because the journal is doing the work `open`/`read`/`write` do on a filesystem.

```ts
interface Kernel {
  // 1. log in — the only door to authority; returns a project-confined scope
  authenticate(credentials: Credentials): Scope;

  // 2-3. the journal — the only write, the only read
  append(path: Path, events: Event[]): Promise<{ offset: number }>;
  read(path: Path, opts?: { after?: number; types?: EventType[]; fold?: string });

  // 4. HTTP in and out — ONE fetch (§6.11): internal names route in (free),
  //    external origins hit the egress door (the whole security surface)
  fetch(req: Request): Promise<Response>;
}
```

**The types (all of them).** A `Path` (`"/agents/researcher"`) names an entity
— exactly like a filesystem path names a file, and like inodes, the entity at a
path exists virtually and is materialized by first touch. An `EventType`
(`"events.iterate.com/agents/message-received"`) is a URI whose namespace names
the owning module (§6.5) — the OS analogue is a filename extension that says
which program handles it. An `Event` is `{ type, payload, idempotencyKey?,
ephemeral? }` with `{ offset, path, source, at }` stamped by the kernel on
commit. An `Expression` is the universal quoted call —
`{ path } | { call, args } | { bind, props }` — where binding an argument
narrows a capability (§6.7), the object-capability version of passing a
file descriptor with reduced permissions. A `Contract` and a `Processor` round
it out: a fold (`reduce`) plus keyed side effects (`processEvent`) plus an
obligation reconciler (`reconcile`).

**A tiny example.** Everything else is sugar over `append`:

```ts
const scope = kernel.authenticate(creds);           // syscall 1

// message an agent that doesn't exist yet — birth is just the first append
await scope.append("/agents/researcher", [
  { type: "events.iterate.com/agents/message-received",
    payload: { text: "summarize today's incidents" } },
]);

// subscribe a stream to a processor: also just an append
await scope.append("/agents/researcher", [
  { type: "stream/subscription-configured",
    payload: { target: { path: ["myProcessor", "processEventBatch"] } } },
]);

// read the folded conversation instead of raw rows
const state = await scope.read("/agents/researcher", { fold: "agent" });
```

`subscribe`, `mount`, `call`, `birth`, and `schedule` are **not** extra
syscalls — they are appends of specific event types (§6.9). A call is an
ephemeral append plus a follow-until-completed; a durable workflow is the same
append that _stays_. Retention is the only axis.

**The shell is a privileged client of the same syscalls.** This is the load-
bearing OS truth: a Unix shell has no special powers — it makes the same
syscalls any program can. `os.iterate.com` is the same. It is a TanStack Start
app served by the one worker's `os` lane (`src/worker.ts:101-105`); every button
it draws is `authenticate` + `read` + `append` against the exact `itx` surface
an agent script uses (`newHttpBatchRpcResponse(request, unauthenticated)`,
`src/worker.ts:243-246`). The dashboard is privileged only in _which scope_ it
authenticates as (an operator standing outside the entity), never in _what verbs
it may call_. "The events ARE the API" (§1.1) is the same statement as "the
shell is not special."

---

## 5. How this differs from today

Concrete deltas, ordered by how much weight they remove.

- **`rpc-targets.ts` (6,014 lines, verified) → thin authority + std-lib
  modules.** Today the platform's own tools are second-class citizens of its
  "connect any tool" mechanism: 54 hand-written dispatch classes resolved
  _before_ the capability-table walk, dragging four parallel description
  corpora, collision guards, and 11 near-identical collection classes (§5.1).
  The smoking gun is a dispatch branch that throws `builtin integration "…" has
  no dispatch branch` one line above the generic fall-through that could have
  served it (`rpc-targets.ts:2415-2420`). In the OS framing this file is
  scaffolding, not a kernel module: built-ins become ordinary described mounts
  resolved by one walk; the file shrinks toward the four nouns its own header
  names.

- **The `sandboxes` domain → a mount, not a subsystem (§6.13).** A sandbox
  _feels_ like heavyweight platform machinery (containers, processes,
  persistence) but under the razor it is one capability you mount, and "which
  provider" (Cloudflare containers, Fly, E2B, Modal, a Mac in a menu bar, a
  Raspberry Pi) is just which mount. There is no `sandboxes` root member; it is
  `itx.mount("machines/fly", …)` like any other tool, and its one kernel
  touch-point is that its egress routes through the project's one door. The
  1.7k lines of `domains/sandboxes/` SDK hardening are one provider's Ring-3
  adapter, not a platform concept.

- **The two-surface split the dashboard doesn't cleanly have yet.** The console
  today conflates trustee, developer, operator, employee, and customer roles in
  one product surface (~20,020 lines of `_app` routes + shared components,
  Appendix D §D). The tell: **"Open" on the project list routes into a
  new-agent page rather than the project's own domain**
  (`src/routes/_app/projects/index.tsx:265,317-320`) — that is an
  _entity-shaped_ action leaking into the hypervisor console. It should open the
  entity's domain; the console should keep only outside-the-entity operations
  (registry, health, raw journals, grants, recovery). The routing plumbing to
  do it already exists — `decideIngressRoute` already distinguishes the `os`
  lane from project hosts, app subdomains, and custom hostnames
  (`src/ingress.ts:41-114`, `src/worker.ts:94-105`) — the dashboard just hasn't
  drawn the line the router already knows how to enforce.

- **The channel machinery collapses (§5.2) and processors leave the kernel's
  face (§6.6).** The external-event → agent arrow is implemented four times
  (Slack, Telegram, email, GitHub PR), ~8.3k lines, each shaped after the last
  by its own admission. Under the fleet rule these become one parameterized
  Channel processor plus per-vendor transcription that can move into the seeded
  `worker.ts` — so the platform ships zero vendor transcribers and "self-
  improve" can finally reach channel behavior, which today it can't because it's
  kernel-adjacent platform code.

---

## 6. Where this framing is wrong

### Attack #1: the OS analogy lies in at least three places

A classic OS is **not append-only**. Its filesystem is mutable in place; you
`write()` over old bytes. iterate's journal never overwrites — the "filesystem"
is a log, and "state" is a fold of it. That is a genuinely different data model,
and the analogy quietly imports the wrong intuition (edit-in-place) unless you
keep saying "append-only" out loud. Second: a classic scheduler is
**deterministic** — it runs the next runnable thread. iterate's most important
step function is sometimes an LLM, i.e. a **stochastic** step, and the only
thing that keeps replay honest is that the stochastic output is _written down as
a fact and read back on replay, never recomputed_ (§6.14). No OS textbook
prepares you for a scheduler whose step is a dice roll you must journal. Third,
and worst for this essay: **the kernel is arguably not the hero.** The kernel
razor (§6.12) correctly proves the kernel is _small_ — streams themselves are
userspace-expressible; the irreducible core is just "confined code + durable
storage + one exit." But "small and load-bearing" is not "the point." The point
(§6.14) is the **intelligent entity runtime** — the durable outer event loop
wrapping an ordinary language runtime, in which deterministic folds and
stochastic AI steps take turns over one history. Leading with "it's an OS, look
at the tiny kernel" risks selling the foundation and forgetting the building.
The kernel is where the security wall is; it is not what the system _is_.

### Attack #2: the "intelligent entity runtime" framing

Its strength is exactly my attack #1 — it names the hero the kernel-view demotes.
But it has a matching weakness: it is a **story about the interesting 5%**, and
it goes quiet about the boring 95% that actually ships a product to a million
tenants. "A durable outer event loop where folds and AI steps take turns" tells
you nothing about fleet updates, schema migration measured in years, package
governance, billing, or the recovery console — the very machinery that the OS
framing's rings and fleet rule are built to organize (Appendix D §A, §B, §D).
The runtime framing is also _seductive toward the wrong product_: it makes
"self-improving entities that rewrite themselves" feel like the mandate, which
tempts you toward shadow-worldline self-promotion (a false-confidence engine —
offline replay cannot reconstruct the counterfactual world, and the entity
grades itself with its own model, i.e. automated Goodharting, Appendix D §C).
And it has no natural place to stand for governance: an "entity runtime" is a
first-person view from _inside_ the entity, but a non-technical founder must
sometimes stand _outside_ a broken entity and revoke its code — which is a
_second shell_, a hypervisor concept the runtime framing doesn't reach for.

### Attack #3: the "one big log" framing

Its strength is real: the journal genuinely _is_ the substance, "the only write
is an append" is a true kernel law, and portability ("tar the repo and the
journal, carry the whole entity to a laptop") is a real moat. But "everything is
one big log" is the framing most likely to **hide incompatible guarantees
behind one noun** (Appendix D §C). A journal row that is an immutable business
fact is not operationally the same as a transient LLM token, an HTTP request
awaiting a response, a supervised external obligation, or a live WebSocket — and
the code already proves it, because it had to introduce a second-class
`ephemeral` event that is committed and ordered but excluded from durable reads
and delivery (§6.9, Appendix D §C). Push the log framing to a theorem and every
missing semantic reappears as a type-string convention, an envelope flag, a
special processor rule, an invisible retention policy — "the root interface
becomes small while the protocol becomes enormous." This is Unix's own history:
"everything is a file" survived by growing `ioctl`, `/proc`, `mmap`, and
sockets; the abstraction won, literal uniformity did not. The log is the right
_substance_ and the wrong _explanation_ — it tells a newcomer what bytes are
stored, not what the machine is for. The OS framing keeps the log as the
kernel's filesystem while admitting the parts that aren't logs (live transport,
blobs, external obligations, the two shells) retain distinct semantics — which
is less pure, and more correct.

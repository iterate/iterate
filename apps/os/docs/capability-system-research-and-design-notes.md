# Capability System Research And Design Notes

Last updated: 2026-06-08

## Jonas Scratchpad: Desired Code Shapes

Code I'd like to be able to write:

```ts
// in a global context
ctx.streams.get({ namespace, path }).append({ type: "hello-world" });
ctx.projects.list();

// all these should work for convenience
ctx.projects.get(id || slug);

// StreamsCapability should "narrow"
ctx.projects.get("bla-slug").streams.get("/"); // should just work

ctx.projects.get("bla-slug").fetch(request); // fetc the worker

// in a narrowed single-project context! via mounts or maybe separate RootContext form IterateContext or IterateProjectContext or sth
// this should only list this project's workspace
ctx.workspaces.list();
ctx.streams.get("/").append({ type, payload });
ctx.workspaces.get("bla").git.add("file.txt"); // etc

// to provide capabilities
ctx.provideCapability({ connectionKey, rpcTarget }); // where rpcTarget has "someMethod"
// then
ctx.connections.get(connectionKey).someMethod(args);

// return what's on the iterate config worker
ctx.worker.fetch(request);

// fetch out of the worker with secret substitution
ctx.worker.egressFetch(request);
```

Some random thoughts:

- we need to think about which domain objects are identified by slug or by id or by path
- are there any cases other than streams where we have this explicit { namespace, path } tuple?
- which domain objects should be implicitly creatable? for instance, creating a stream should be possible by `ctx.streams.get({ namespace, path }).append({ type, payload })` . but maybe that is the only example? do we need this currying elsewhere?
- where does the database of objects that exist live? for instance, is there a global workspaces database or is it just within a project durable object?
  - if it's just within a project durable object, our DB will be way more horizontally scalable
- we need rules of thumb for
  - whether or not a domain object exists on the root or not. streams exists on root, for example, because there is a "global" stream namespace that is shared across projects. but this is maybe the only exception?
    - or maybe we enforce it everywhere? and say our domain objects all have this structure?
      - if i know a repo id that's globally unique, it's nice to be able to do ctx.repos.get(id).getInfo()
        - but on the flipside, It's more scalable and cleaner to actually maybe have the same namespace concept on all of our durable objects. That would then be really easy to reason about as well. then we could do the same thing as streams where ctx.repos.get({namespace: projectId, repo: repoSlug}).getInfo()
- for objects that are _directly_ tied to a stream, wouldn't it make sense to use the stream path as durable object name?
  - ctx.repos.get({ namespace: projectId, path: `/repos/${repoSlug}` }).getInfo() - but that seems maybe a bit bad
  - how to structure collection capabilities for listing elements of a collection etc
  - what should the name of a durable object be? should it be like in streams where it's namespace:path? should it be like the old-style durable object mixins where the name is json? should it be a query string with sorted query keys? not clear

- We should NOT use slugs in stream paths if the slugs are meant to be mutable.
- we don't want to build ourselves into a corner performance-wise
  - don't want to actually wake a DO or make a network call until an invocation
- What props are passed to ProjectCapability? is it standardised?
  - Does project capability get passed a projectId or a project durable object stub?
  - Should the capability get the cloudflare execution context and env? Is that good or bad security
- we need to somehow unpick whether ProjectCapability is the same thing as iterate context etc.. 99% of the time when we see ctx. it will be in the context of one project, then we should just have ctx.workspaces and ctx.streams and ctx.repos and that should all be what you expect. potentially even ctx.ingressFetch() and ctx.egressFetch() etc. but we also need to think about when we do or don't want a new durable object to be necessary.
- Need to always be mindful that we also need a worker entrypoint that is bindable to dynamic and workers for platforms workers. though it can be env.ITERATE.getContext() or (or .context getter as is currently the case)
- we need some way to reason about how domain objects are _listed_
  - for now, maybe we should say that the list of repos, workspaces, etc is produced as reduced state by the project processor
- we need to think about how this fits in with stream processors.
- We need to create documentation that can be used whenever a new domain object is added.
- We should list out explciitly all the different situations in which we'd see ctx. code.
  - browser UI
  - vitest e2e tests
  - codemode scripts
  - iterate config repo
  - one-off admin scripts across projects / accounts
- how does all this tie in with stream paths? we want some symmetry between even source code paths and stream paths and event types and so on
- should we just introduce a "root iterate context" that is separate from an iterate context and can cover multiple projects? i'd prefer not, because i can also imagine more stuff than just whoami() on the root context
- we need to allow for situations where a single iterate context has many workspaces or repos or whatever attached to it - ideally solve it with mounts

Things I think I've decided

- We don't want a global D1 index of all these domain objects - that means for _listing_ we need to wake up the Project durable object (to get project processor reduced state)
- We should use specific well defined domain objects as example when discussing this
  - project
    - interesting because 99% of the time `ctx` is actually
  - repo (identified by immutable slug within a project)
    - interesting because every project gains a repo with "iterate-config" slug (slugs unique within project)
    - this repo is forked from a _global_ repo that doesn't exist in any one project! so maybe this is a "namespace" situation?
  - workspace
    - each agent gets a brand new workspace when it spins up
    - one-off admin scripts might want to use a workspace in some global namespace
  -

## Grill Session: Starter Domain Objects

Status: in progress.

Resolved so far:

- Organization ownership is outside the capability tree's root. The root is the
  authority derived from the current **Capability Scope**, which comes from an
  auth-worker session, OAuth token, or admin token.
- A single `ctx` should work for both broad admin scripts and narrowed
  project-focused sessions. The difference is not a separate universe of APIs;
  it is which capabilities the scope can reach and which shortcuts are mounted.
- Anything with a deliberate global address should be reachable from the root
  when the scope authorizes it. Project focus should curry or mount addresses,
  not make those objects unreachable from the root.
- Do not introduce a generic "Domain Namespace" term right now. Each domain owns
  its namespace concept: **Stream Namespace**, **Repo Namespace**, and
  **Workspace Namespace**.
- At the root, namespace is explicit. Global resources must use an explicit
  namespace such as `"global"`; omitted namespace should not silently mean
  Global.
- For this phase, ignore narrowing and mounts except where they clarify the
  global tree. The immediate design artifact should be one TypeScript sketch
  that lays out the global capability hierarchy, types, methods, and address
  parsing rules.
- `project.fetch(request)` is Project Ingress fetch. `project.worker.fetch(request)`
  is direct Project Worker Fetch.
- Initial permission model: if a Capability Scope grants access to a Project,
  the holder can use that Project and its current domain objects broadly. Fine
  grained per-method/per-child authorization is not the first design target.
- `project.stream` means Project Lifecycle Stream in the global Project
  hierarchy. A future stream-focused context may also want `.stream` to mean the
  focused stream; defer that ambiguity to the narrowing/mounting phase.
- Future narrowing is not settled. This discovery is an argument against
  treating "a ctx focused on exactly one Project" as identical to
  `ctx.projects.get("bla")`. A Project-focused ctx is a projection over root
  authority with its own defaults and mounted names; a Project capability is the
  Project object in the global hierarchy.

For the design conversation, use a deliberately small domain-object set that
exercises the main capability-system problems without pulling in every current
OS feature.

### Proposed starter objects

1. **Project**

   Durable owner for one OS Project. It is selected by stable Project ID, even
   when callers use Project Slug for convenience. For examples, its simplified
   control surface is:

   ```ts
   project.fetch(request);
   project.egressFetch(request);
   project.worker.fetch(request);
   project.worker.someMethod(args);
   project.listWorkspaces();
   project.listRepos();
   ```

   The Project is the default narrowing point for most `ctx.*` code. In a
   single-project context, `ctx.streams`, `ctx.workspaces`, `ctx.repos`, and
   `ctx.worker` are project-scoped shortcuts.

   Project Worker is intentionally in the starter set because it forces a
   different kind of capability surface: the project config worker can define
   methods that OS does not know at compile time.

   ```ts
   export default {
     someMethod: () => "bla",
   };

   await ctx.projects.get("bla").worker.someMethod();
   ```

2. **Stream**

   Durable owner for one Event Stream Path inside one Stream Namespace. For
   examples, its simplified surface is:

   ```ts
   stream.append(event);
   stream.subscribe(options);
   stream.read(options);
   ```

   Streams can be addressed at the root by object or string:

   ```ts
   ctx.streams.get({ namespace, path: "/some/path" });
   ctx.streams.get("some-namespace:/some/path");
   ```

   A Project-derived streams collection fills the Stream Namespace:

   ```ts
   ctx.projects.get("bla").streams.get("/some-stream");
   ctx.projects.get("bla").streams.get({ path: "/some-stream" });
   ```

3. **Workspace**

   Durable owner for one live file surface inside one Workspace Namespace. Most
   Workspaces are project-scoped, but the model should support a global/admin
   Workspace Namespace. For examples, its simplified surface is:

   ```ts
   workspace.writeFile({ path, content });
   workspace.readFile({ path });
   workspace.git.add({ path });
   workspace.git.commit({ message });
   ```

   The nested Git capability is a facet of Workspace authority, not a separate
   root object for this first model.

4. **Repo**

   Durable owner for one versioned file tree inside one Repo Namespace. Most
   Repos are project-scoped, but the starter model must also support a global
   base Repo such as `iterate-config-base`. For examples, its simplified surface
   is:

   ```ts
   repo.describe();
   repo.refreshWriteToken();
   repo.getArtifact();
   ```

   Repo stays in the starter set because it forces the address question:
   current language says Repo Slug is project-local, while the base Repo proves
   not every Repo belongs to one Project.

### Proposed relationship model

```text
Capability Scope
├── Projects
│   └── Project
│       ├── Project Lifecycle Stream: Stream Namespace = Project ID, path = /
│       ├── Streams: Stream Namespace = Project ID, path = any Event Stream Path
│       ├── Workspaces: Workspace Namespace = Project ID
│       ├── Repos: Repo Namespace = Project ID
│       └── Project Worker: dynamic method surface controlled through Project
├── Streams: admin-root addressable by Stream Namespace + Event Stream Path
├── Repos: admin-root addressable by Repo Namespace + Repo Slug
└── Workspaces: admin-root addressable by Workspace Namespace + Workspace Slug/ID
```

For this model, Project owns authorization for user-derived access to project
children. Repos and Workspaces do not need global D1 listing indexes in the
example. Listing `ctx.projects.get("bla").workspaces.list()` reads the
`/workspaces` collection stream reduced state in that Project's Workspace
Namespace. Admin root selection can still avoid waking Project when the admin
caller already has the full namespace-local address.

Example access patterns:

```ts
// broad admin context only for direct namespace access
ctx.projects.get(projectIdOrSlug);
ctx.streams.get({ namespace, path });
ctx.streams.get("some-namespace:/some/path");
ctx.repos.get({ namespace, slug });
ctx.workspaces.get({ namespace, slug });

// Project-derived collections fill namespace
ctx.projects.get("bla").streams.get("/some-stream");
ctx.projects.get("bla").repos.get({ slug: "iterate-config" });
ctx.projects.get("bla").workspaces.get({ slug: "agent-workspace" });
ctx.projects.get("bla").egressFetch(request);
ctx.projects.get("bla").worker.fetch(request);
ctx.projects.get("bla").worker.someMethod(args);
```

### Proposed Durable Object rule

Durable Objects should expose small command/state surfaces and should not be the
primary authorization layer. Capability wrappers decide whether a caller may
derive a handle. The DO may still enforce invariant checks that protect its own
state, such as "Repo already exists" or "Workspace file path is invalid".

### Proposed address and Durable Object name rule

Decision: accepted in principle. Durable Object names are private implementation
strings. Public capability code should talk in domain addresses, not DO name
strings.

Each root-addressable domain owns one address module. That module is the only
place that parses user-facing addresses and constructs Durable Object structured
names.

Example shape:

```ts
type StreamAddress = { namespace: string; path: string };
type RepoAddress = { namespace: string; slug: string };
type WorkspaceAddress = { namespace: string; slug: string };

parseStreamAddress(input: StreamAddress | string): StreamAddress;
parseRepoAddress(input: RepoAddress | string): RepoAddress;
parseWorkspaceAddress(input: WorkspaceAddress | string): WorkspaceAddress;

toStreamDurableObjectName(address: StreamAddress): string;
toRepoDurableObjectName(address: RepoAddress): string;
toWorkspaceDurableObjectName(address: WorkspaceAddress): string;
```

Capabilities should call these helpers. They should not assemble Durable Object
names ad hoc.

Current code note:

- Streams currently use a manual string name: `${namespace}:${path}`.
- Repos and Workspaces currently use lifecycle structured names serialized as
  canonical JSON through `deriveDurableObjectNameFromStructuredName`.
- The design should converge on one documented rule per domain, even if the
  implementation migrates gradually.

Unresolved file-layout question:

Option A: many focused modules.

```text
domains/streams/address.ts
domains/streams/capability.ts
domains/streams/stream-capability.ts
```

Option B: one domain utility module for small domains.

```text
domains/streams/stream-domain.ts
domains/repos/repo-domain.ts
domains/workspaces/workspace-domain.ts
```

Option C: a default-exported domain descriptor object that satisfies a shared
interface.

```ts
export default {
  parseAddress,
  toStructuredName,
  toDurableObjectName,
  namespaceLabel: "Stream Namespace",
} satisfies DurableDomainDefinition<StreamAddress, StreamStructuredName>;
```

Option D: domain address value-object classes.

```ts
export class StreamAddress {
  static parse(input: StreamAddressInput): StreamAddress;
  static from(input: { namespace: string; path: string }): StreamAddress;

  readonly namespace: string;
  readonly path: string;

  toString(): `${string}:/${string}`;
  toStructuredName(): StreamStructuredName;
  toDurableObjectName(): string;
}

export class RepoAddress {
  static parse(input: RepoAddressInput): RepoAddress;
  static from(input: { namespace: string; slug: string }): RepoAddress;

  readonly namespace: string;
  readonly slug: string;

  toString(): `${string}:${string}`;
  toStructuredName(): RepoStructuredName;
  toDurableObjectName(): string;
}
```

Current concern: `address.ts` per domain may create too many tiny files. A
domain-level utilities/definition module may make the convention more visible.
The open question is whether a descriptor object is genuinely useful or just an
abstraction around a few named functions.

Decision for this design phase: reject the value-object class and domain
descriptor directions as too much named machinery.

Keep the sketch deliberately simple:

- the root collection capability accepts the input shape;
- the capability constructs the Durable Object name with a one-liner;
- the corresponding Durable Object parses its name with a one-liner;
- only extract value objects/helpers after repeated real code proves they are
  needed.
- use `namespace:localAddress` as the provisional Durable Object name format for
  starter domains.

Example sketch:

```ts
class StreamsCapability extends RpcTarget {
  get(input: { namespace: string; path: string } | `${string}:/${string}`) {
    const name = typeof input === "string" ? input : `${input.namespace}:${input.path}`;
    return new StreamCapability(this.env.STREAM.getByName(name));
  }
}

class StreamDurableObject extends DurableObject {
  get address() {
    const [namespace, path] = this.ctx.id.name!.split(/:(?=\/)/);
    return { namespace, path };
  }
}
```

This still treats Durable Object names as private implementation strings: they
are private to the capability/DO pair, not public product language.

Locked provisional examples:

```ts
const streamName = `${namespace}:${path}`; // "proj_123:/some/path"
const repoName = `${namespace}:${slug}`; // "proj_123:iterate-config"
const workspaceName = `${namespace}:${slug}`; // "proj_123:agent-workspace"
```

Move on without solving escaping or canonical structured-name helpers. Revisit
only if the simple format becomes ambiguous in real code.

### Collection operations in the global hierarchy

Resolved:

- `ctx.projects.list()` exists because Projects have a normal app-level D1
  listing projection.
- `ctx.projects.create({ slug, ...optional })` exists. `slug` is required;
  everything else is optional.
- `ctx.streams.list()` does not exist in the starter global sketch.
- Root plural collection capabilities exist even when they are admin-only.
  Root plural means "admin-addressable collection selector", not "global list of
  all objects".

Resolved:

- A root `ctx.repos` collection does exist for admin-only direct addressable
  operations such as `get({ namespace, slug })`, `create({ namespace, slug })`,
  and `list({ namespace })`.
- A root `ctx.workspaces` collection exists with the same namespace-scoped
  admin-only shape.

Two possible listing models:

Model A: Project-owned listing.

```ts
ctx.projects.get("bla").repos.list();
```

Repo listing comes from Project reduced state. Root `ctx.repos.list(...)` does
not exist because root `ctx.repos` has no global listing index.

Model B: Collection stream-owned listing.

```ts
ctx.repos.list({ namespace }); // admin-only root selector
ctx.projects.get("bla").repos.list(); // project-authorized selector
```

Repo listing comes from the `/repos` collection stream in the Repo Namespace.
That stream's reduced state tracks child Repo streams, so listing does not need
to wake Project or ask the Project processor. A future plural Repos processor can
own this reduced state explicitly.

Current decision: use Model B for the sketch. If Repos have a Repo Namespace,
then admin root `ctx.repos.list({ namespace })` should exist. Project-derived
`ctx.projects.get("bla").repos.list()` uses the same collection-stream model
with Project ID as Repo Namespace, but it should not delegate through the
admin-only root method.

Repo creation decision:

```ts
ctx.repos.create({ namespace, slug });
```

appends the Repo Created Event to the per-Repo stream:

```ts
`/repos/${slug}`;
```

not to `/repos`. The `/repos` collection stream is the collection index/reduced
listing surface. It should learn about children through child stream creation or
collection-level reducer signals, not own each Repo's lifecycle facts.

Workspace decision:

Workspaces mirror Repos in the starter sketch:

```ts
ctx.workspaces.get({ namespace, slug });
ctx.workspaces.create({ namespace, slug });
ctx.workspaces.list({ namespace });
ctx.projects.get("bla").workspaces.get({ slug });
ctx.projects.get("bla").workspaces.create({ slug });
ctx.projects.get("bla").workspaces.list();
```

Workspace creation facts go to `/workspaces/{slug}`. `/workspaces` is the
collection index/listing surface.

Create return decision:

`create()` on collection capabilities returns the singular capability, not just
data.

```ts
const repo = await ctx.repos.create({ namespace, slug });
await repo.describe();
```

The capability model says creation gives you the object capability you just
created. Adapters that need plain data can call a method on the returned
capability.

Project creation decision:

`ctx.projects.create(...)` is part of the starter capability tree.

```ts
const project = await ctx.projects.create({
  slug: "alpha",
  organization: { slug: "iterate" }, // optional
});
await project.describe();
```

The input requires `slug`; all other creation knobs are optional, including
`organization`. The current runtime code already has a nearby shape,
`ProjectsCapability.create({ id?, slug })`, while the Project Durable Object's
**Create Project Command** takes the allocated `{ projectId, slug }`.

Project creation authorization rule:

- `admin-api-secret` may create anywhere. It may pass `organization`, or omit it
  for an admin/system-created Project if the implementation supports that.
- `iterate-auth` may create only in an Organization present in its serialized
  auth-worker organization claims.
- If `iterate-auth` omits `organization`, use the caller's default/first
  Organization claim, matching today's active-organization behavior.

This is the one root collection creation path that can mint a brand-new Project
capability rather than selecting an already-authorized Project. That is fine,
but it means Project creation authorization is a separate question from Project
selection authorization. Organization remains an input to creation, not a new
root branch in the capability tree for this phase.

Public read naming decision:

Use `describe()` as the standard self-read method on singular capabilities and
their matching Durable Objects. This is a naming symmetry, not a required base
class, shared interface, or abstraction.

```ts
await project.describe();
await stream.describe();
await repo.describe();
await workspace.describe();
```

Use collection words for collection capabilities:

```ts
ctx.projects.get("alpha"); // returns ProjectCapability
ctx.projects.list(); // returns project descriptions/summaries
ctx.projects.create({ slug }); // returns ProjectCapability
```

Avoid adding new `getInfo()` or `getSummary()` methods as the main public naming
pattern. They can remain as transitional aliases where the current code already
has them, especially `ProjectDurableObject.getSummary()` and
`RepoDurableObject.getInfo()`, but new examples and new domain objects should
prefer `describe()`.

Every singular capability should expose `describe()`, even if its initial result
is only its stable address, such as `{ namespace, path }` or `{ namespace, slug
}`. Keep the return shape domain-specific and serializable.

Rationale:

- `get(...)` already means select a child object from a collection.
- `list(...)` means enumerate a collection.
- `create(...)` means create and return the new singular capability.
- `describe()` means return serializable data about this singular capability's
  current target.
- `info` and `summary` are easy to apply inconsistently across domains.

Default project child question:

There may also be useful singular defaults:

```ts
ctx.projects.get("bla").repo; // the Project Repo, currently iterate-config
ctx.projects.get("bla").workspace; // the main Project Workspace
```

These are not replacements for plural collections:

```ts
project.repo === project.repos.get({ slug: "iterate-config" });
project.workspace === project.workspaces.get({ slug: "main" }); // exact slug TBD
```

Open naming question: if `project.repo` means the Project Repo, then
`project.repos` remains the collection. If `project.workspace` means the main
Project Workspace, then `project.workspaces` remains the collection. This is
nice symmetry, but it creates a strong convention that singular properties are
default project children.

Decision: `project.repo` and `project.workspace` are getters. They represent
invariant default Project children that should always exist. If missing, it is
acceptable for the getter path to initialize or repair them.

This is a deliberate exception to the general getter rule. It is acceptable
because the getter is not choosing arbitrary product state; it is selecting a
well-known Project invariant.

Project stream decision:

```ts
project.stream === project.streams.get("/");
```

`project.stream` is the Project Lifecycle Stream at Event Stream Path `/` in the
Project's Stream Namespace. It must not mean "current stream".

Later-context warning: this is only true in the global Project hierarchy. In a
future context focused on an Agent thread, Codemode Session, or other stream,
`.stream` may naturally mean the focused stream. We should not solve that here;
the mounting/narrowing design needs to decide whether focused stream contexts
use `ctx.stream`, `ctx.agent.stream`, or some other spelling.

Default child symmetry:

```ts
project.stream; // Project Lifecycle Stream
project.repo; // Project Repo / iterate-config
project.workspace; // main Project Workspace

project.streams; // Stream collection in Project Stream Namespace
project.repos; // Repo collection in Project Repo Namespace
project.workspaces; // Workspace collection in Project Workspace Namespace
```

Singular/plural decision:

Every starter domain should have one singular object capability and one plural
collection capability:

```ts
StreamDurableObject     <-> StreamCapability
RepoDurableObject       <-> RepoCapability
WorkspaceDurableObject  <-> WorkspaceCapability
ProjectDurableObject    <-> ProjectCapability

StreamsCapability
ReposCapability
WorkspacesCapability
ProjectsCapability
```

Singular means object handle. Plural means collection selector/list/create
surface.

This also gives a cleaner rule for future domains:

```ts
ctx.<plural>.get({ namespace, ...localAddress });
ctx.<plural>.list({ namespace }); // if the domain has a collection stream/index
ctx.projects.get("bla").<plural>.get(...localAddress);
ctx.projects.get("bla").<plural>.list();
```

Do not invent a global D1 index for product child objects just to make root
listing work.

### Project Worker tension

Project Worker is not like `streams`, `repos`, or `workspaces`: it is a
project-scoped dynamic Worker whose callable methods come from project-authored
code. The capability layer still needs a stable OS-owned shape around it:

```ts
project.worker.fetch(request);
project.worker.call({ name: "someMethod", args });
project.worker.someMethod(...args);
```

Open design constraints:

- The capability must not expose the raw dynamic worker entrypoint. Current repo
  notes say dynamic workers loaded with `env.LOADER.load(...).getEntrypoint()`
  must stay owned by the worker with the loader binding; do not pass those
  entrypoints, their bound methods, or unresolved RPC promises into another
  dynamic worker.
- Therefore `project.worker` has to be a facade that keeps the real dynamic
  worker behind Project and forwards calls.
- `egressFetch` belongs to Project, not Project Worker.
- `fetch` is an OS-owned reserved method on Project Worker.
- `project.fetch(request)` remains the Project Ingress path.
- `project.worker.fetch(request)` is a direct Project Worker Fetch.
- Unknown string properties should forward to project config worker functions.
- The forwarding object probably needs Proxy-backed `RpcTarget` behavior, as the
  current `ProjectWorkerCapability` already does.
- The capability layer must prevent dynamic project methods from shadowing or
  stealing OS-reserved methods.
- We need a story for typed/introspected dynamic methods later, but the global
  hierarchy should allow the untyped method-call form now.

Evidence in current repo:

- `apps/os/src/capnweb/LEARNINGS.md` has "Do Not Transfer Dynamic Worker
  Entrypoints".
- `apps/os/src/capnweb/project-capability.ts` says `ctx.project.worker` must not
  expose the raw iterate-config dynamic worker entrypoint and currently uses a
  parent-owned Proxy-backed `RpcTarget` facade.

### Durable Object public interface forwarding

Decision direction: when a caller has Project capability authority, Project DO
public methods should be easy to call from codemode/Cap'n Web scripts. The first
permission model is broad project authority: access to Project implies access to
its public Project control surface and child domain objects.

Existing helper:

```ts
import { createRpcTargetClass } from "@iterate-com/shared/capabilities";
```

`packages/shared/src/capabilities.ts` exports `createRpcTargetClass(sourceClass)`.
It creates an `RpcTarget` class that forwards public prototype methods from a
source object. This can reduce manual boilerplate when exposing a Durable
Object's public interface through a capability facade.

Rejected sketch shape:

```ts
const ProjectDurableObjectRpcTarget = createRpcTargetClass(ProjectDurableObject);

class ProjectCapability extends ProjectDurableObjectRpcTarget {
  get stream() { ... }
  get streams() { ... }
  get repo() { ... }
  get repos() { ... }
  get workspace() { ... }
  get workspaces() { ... }
  get worker() { ... }
}
```

This is too many named concepts. The design should have one Durable Object class
and one matching external Capability class. The Durable Object does not expose or
use the Capability internally:

```ts
class ProjectDurableObject extends DurableObject {
  get stream() { return this.env.STREAM.getByName(`${this.id}:/`); }
  streamAt(path) { return this.env.STREAM.getByName(`${this.id}:${path}`); }
  get repo() { return this.env.REPO.getByName(`${this.id}:iterate-config`); }
  repoBySlug(slug) { return this.env.REPO.getByName(`${this.id}:${slug}`); }
  get workspace() { return this.env.WORKSPACE.getByName(`${this.id}:main`); }
  workspaceBySlug(slug) {
    return this.env.WORKSPACE.getByName(`${this.id}:${slug}`);
  }

  fetch(request) { ... }
  egressFetch(request) { ... }
  describe() { ... }
}

class ProjectCapability extends RpcTarget {
  constructor(private readonly project: DurableObjectStub<ProjectDurableObject>) {
    super();
  }

  fetch(request) {
    return this.project.fetch(request);
  }

  egressFetch(request) {
    return this.project.egressFetch(request);
  }

  get stream() { ... }
  get streams() { ... }
  get repo() { ... }
  get repos() { ... }
  get workspace() { ... }
  get workspaces() { ... }
  get worker() { ... }
}
```

If `createRpcTargetClass` is useful, it should be hidden inside the
implementation of the one Capability class or replaced by a helper that installs
forwarders onto that class. It should not create a second named capability-like
class in the conceptual model.

Project child surface decision:

The sharper cut is: OS `RpcTarget` capabilities are the external, serializable
authority membrane. Durable Objects are domain actors and should not import,
construct, or consume those capability wrappers for their own internal work.

Capabilities:

- receive serializable `props`;
- perform authorization checks;
- narrow authority by constructing other capabilities with narrower props;
- call Durable Object stubs only at terminal operations.

Durable Objects:

- implement domain state and commands;
- may expose internal convenience getters like `this.stream`, `this.repo`, and
  `this.workspace`;
- return direct Durable Object stubs or local trusted helper objects from those
  internal getters;
- do not call `this.getCapability().stream`, `this.getCapability().repo`, or
  `new ProjectCapability(...)` as an internal composition mechanism.

Example boundary:

```ts
// Capability layer:
ctx.projects.get("proj_123").repos.get("main").describe();
// narrows -> checks -> terminal Repo Durable Object stub call

// Durable Object layer:
this.repo.describe();
// direct Repo Durable Object stub/helper call, no ProjectCapability detour
```

This makes the same domain word intentionally mean two implementation things:

- external `project.repo` is a `RepoCapability`;
- internal `this.repo` is a direct `RepoDurableObject` stub or trusted local
  helper.

That split is acceptable because the two layers have different jobs. The
capability layer is a security boundary. The DO layer is trusted implementation
code.

The reason to avoid self-use of capabilities is concrete, not aesthetic. A
deployed Cloudflare probe on 2026-06-08 showed that a Durable Object calling
`env.PROBE.getByName(this.ctx.id.name).leaf()` from inside itself produced real
`durable_object_subrequest` and nested `jsrpc` spans in Workers traces. Direct
`this.leaf()` had no such subrequest span. The probe also measured about `0ms`
for direct in-object calls versus about `5ms` for the same-object stub call in
the response payload.

So `ProjectDurableObject` should not implement local behavior through
`this.getCapability().describe()` if that capability would resolve
`env.PROJECT.getByName(projectId).describe()` again. It should call
`this.describe()` directly.

The earlier optional-local-source idea is deprioritized for now:

```ts
new ProjectCapability({ env, props, project: this });
```

That can avoid one self-RPC hop, but it adds a second source mode, raises
sync-method-vs-stub-method questions, and makes the concept harder to explain.
The cleaner starter rule is:

> Stateless, prop-initialized capabilities sit outside Durable Objects. Durable
> Objects do not use those capabilities internally.

`getCapability()` should therefore be treated, if it exists at all, as an export
helper for external callers, not as a DO-local composition primitive. The
sharper future direction is to move capability construction to stateless
WorkerEntrypoints or standalone factories and remove `getCapability()` from the
Durable Object public surface.

For capability terminal methods, do not insert an `await` into the forwarding
path if the method may return an RPC thenable/speculative stub. Cloudflare
Workers RPC promise pipelining depends on returning the original RPC thenable so
callers can write:

```ts
await ctx.agents.create().doThing(args);
```

without first awaiting `create()`. The codemode executor already documents this
rule: wrapping an RPC thenable in a native Promise before returning can erase the
speculative-stub behavior.

```ts
class RepoCapability extends RpcTarget {
  describe() {
    assertCanAccessNamespace(this.input.props.auth, this.input.props.namespace);
    return this.stub().describe();
  }

  clone(input) {
    assertCanAccessNamespace(this.input.props.auth, this.input.props.namespace);
    return this.stub().clone(input);
  }

  private stub() {
    return this.input.env.REPO.getByName(`${this.input.props.namespace}:${this.input.props.slug}`);
  }
}
```

Because the capability always calls a stub at the terminal edge, it does not need
to normalize local and remote sources by `await`ing everything.

Capability forwarding taxonomy:

1. **Child selectors / facets**

   These should be pure capability construction from props/env. They should not
   hit the parent Durable Object just to create the child surface.

   ```ts
   project.streams;
   project.stream;
   project.repos;
   project.repo;
   project.workspaces;
   project.workspace;
   project.worker;
   workspace.git;
   ```

2. **Terminal reads/commands**

   These return serializable data, `Response`, stream data, or other terminal
   values. The capability checks authority and returns the Durable Object stub
   call directly.

   ```ts
   await project.describe();
   await project.egressFetch(request);
   await repo.describe();
   await workspace.readFile({ path });
   ```

3. **Handle-producing commands**

   These return another capability/RPC handle, or a promise that is also a
   speculative stub. Forwarders must preserve the original return value for
   Workers RPC promise pipelining.

   ```ts
   ctx.agents.create().sendMessage(input);
   ctx.sandboxes.create({ slug }).workspace.writeFile(input);
   ```

   Do not wrap these in `async`/`await` unless we have proven the returned value
   is plain data.

The explanation can stay simple:

> Capabilities are reconstructed from `{ env, props }`. They are external facets
> that authorize, narrow, and eventually call Durable Object stubs. Durable
> Objects use direct methods, direct stubs, or local helpers internally.

Open constraints:

- Runtime forwarding should pass through any callable public method that the
  underlying Durable Object stub supports.
- Avoid `Api` suffix naming for capability surfaces. If we need type names, use
  domain words such as "surface" or "public surface", not `ProjectCapabilityApi`.
- Child getters need to be defined explicitly in capability classes. Durable
  Objects may expose same-named internal helpers, but those helpers must not be
  aliases through `getCapability()`.
- Project Worker still needs a facade because the raw dynamic worker entrypoint
  cannot be transferred.
- Type narrowing can be added for editor help, but it should not block runtime
  pass-through to Durable Object public methods.

### RpcTarget constructor shape research question

Sidecar research note:

- `apps/os/docs/rpc-target-constructor-shape-research.md`

When constructing singular `RpcTarget` capabilities such as `ProjectCapability`,
`StreamCapability`, `RepoCapability`, and `WorkspaceCapability`, should the
constructor receive:

1. an already-derived Durable Object stub;
2. `env` plus props/address and derive its own Durable Object stub;
3. a WorkerEntrypoint-like shape with environment plus `ctx.props`;
4. some standardized `{ scope, env, props }` capability runtime object?

Design tensions:

- Object-capability purity suggests passing an already-authorized object
  reference/stub can be clearer: holding the stub is the authority.
- WorkerEntrypoint symmetry suggests `{ props }` is attractive, especially if we
  later want to bind narrowed capabilities into other Workers.
- Passing props could standardize `getCapability(props)` and future narrowing.
- Passing stubs may avoid recomputing names and may better preserve the exact
  authority the parent chose to delegate.
- Need to understand whether deriving a DO stub from namespace/name costs extra
  round trips or is just local stub construction.
- Need to understand lifecycle/dup/dispose behavior when stubs are stored inside
  returned `RpcTarget`s.

Sidecar future-facing recommendation:

```text
Bindable or durable capability = exported WorkerEntrypoint + props.
Ephemeral local facet = RpcTarget may capture a stub or delegate.
Durable Object = state/command owner, not the primary capability wrapper.
```

Current Cap'n Web constraint: today, we cannot rely on using a WorkerEntrypoint
instance itself as a Cap'n Web `RpcTarget` in the way this design needs. That may
be possible soon, but the immediate sketch should use `extends RpcTarget`.

Working recommendation for the current sketch:

```ts
class RepoCapability extends RpcTarget {
  constructor(
    private readonly input: {
      props: {
        auth: CapabilityAuth;
        namespace: string;
        slug: string;
      };
    },
  ) {
    super();
  }
}
```

In other words: implement capabilities as `RpcTarget` for today's Cap'n Web
compatibility, but think of them like WorkerEntrypoints. They are effectively a
function of props, and props carry the narrowed authority.

Props always include `props.auth` for now. Domain-specific props then add the
address fields needed to reach the underlying Durable Object, such as
`namespace`, `path`, or `slug`.

`props.auth` must be serializable data. It should not carry the live OS
`Principal` object because `Principal` includes methods like `can()`. The
capability layer can reconstruct a `Principal`-like helper from the props if
that becomes useful at runtime.

For auth-worker-derived callers, reuse the existing serializable claim types
from `@iterate-com/shared/auth-claims`, especially
`IterateAuthAccessTokenOrganizationClaim` and `IterateAuthProjectClaim`, rather
than inventing parallel project/org claim shapes.

The Admin API Secret is not an auth-worker token and is not issued by
`apps/auth`. It is an OS-local shared secret configured as
`AppConfig.adminApiSecret` from `APP_CONFIG_ADMIN_API_SECRET`. OS checks it
directly before session or bearer-token auth in `resolveRequestAuth()`. A
successful match becomes the singleton OS `adminPrincipal`.

Keep a specific `admin-api-secret` wrapper in capability props so the credential
source is explicit, even though the existing OS principal is currently named
`AdminPrincipal` with `type: "admin"`.

Do not put the raw admin secret, bearer token, or cookies into capability props.

Current sketch auth shape:

```ts
type CapabilityAuth =
  | { type: "admin-api-secret" }
  | {
      type: "iterate-auth";
      userId: string;
      sessionId?: string;
      organizations: IterateAuthAccessTokenOrganizationClaim[];
      projects: IterateAuthProjectClaim[];
      scopes: string[];
    };
```

Prior art in current `apps/os/src/capnweb` uses
`{ scopes: { projects: "all" | string[] } }`. The sketch moves toward carrying
serializable auth data under `auth` and deriving access decisions through helper
functions. The Admin API Secret variant does not need an invented `projects:*`
or `project:*` scope; the discriminant itself means app-level authority.

Auth app source of truth today:

- The auth app uses singular `project:` string scopes.
- OAuth project selection adds `project:${projectId}` entries to the access
  token's `scopes` claim.
- It also includes a `projects` claim with `{ id, slug, organizationId }`
  objects for the selected projects.
- OS currently authorizes access-token principals from the verified `projects`
  claim, not by parsing the `scopes` claim.

Admin auth:

- The current OS admin API secret becomes an `adminPrincipal` in OS.
- This path does not go through `apps/auth`; it is checked directly against
  `context.config.adminApiSecret`.
- Existing Cap'n Web maps that to `{ scopes: { projects: "all" } }`.
- In this sketch, admin auth should be represented explicitly as:

  ```ts
  {
    type: "admin-api-secret";
  }
  ```

`ProjectsCapability.list()` should intersect the normal app-level D1 Project
listing projection with what `capnweb/auth-helpers.ts` derives from
`props.auth`. The Admin API Secret variant sees all D1 projects. An
auth-worker-derived variant sees the verified `projects` claim.

`ProjectsCapability.get(projectIdOrSlug)` should throw immediately if
auth helpers say `props.auth` cannot access the resolved Project ID. Capability
selection is the attenuation boundary; if the caller cannot derive the Project
capability, it should not receive a reference whose methods fail later.

Root namespace authorization decision:

Root collection selectors such as `ctx.streams.get({ namespace, path })`,
`ctx.repos.get({ namespace, slug })`, and
`ctx.workspaces.get({ namespace, slug })` need a rule for namespace access.
Without one, a user-auth-derived root context could construct a handle for any
guessed namespace even though `ctx.projects.get(projectId)` would have thrown.

Decision: root-level direct namespace selectors are admin-only.

```ts
ctx.streams.get({ namespace, path }); // admin-api-secret only
ctx.repos.get({ namespace, slug }); // admin-api-secret only
ctx.repos.list({ namespace }); // admin-api-secret only
ctx.workspaces.get({ namespace, slug }); // admin-api-secret only
ctx.workspaces.list({ namespace }); // admin-api-secret only
```

User-auth-derived callers must first derive an authorized Project capability:

```ts
ctx.projects.get("bla").streams.get("/some/path");
ctx.projects.get("bla").repos.get("main");
ctx.projects.get("bla").workspaces.get("main");
```

Project-narrowed collections carry an already-authorized Project ID namespace,
so they can construct child handles directly. They should not delegate through
root collection methods if those root methods assert admin access.

For the OS sketch, prefer capabilities that can reconstruct their underlying DO
stub from props when a method is called. The exact way env reaches the
capability is implementation wiring; the conceptual constructor shape is
`{ props }`. Creating a DO stub with `getByName()` does not send a request until
a method is invoked.

### Getter vs method design question

Decision: accepted.

This needs its own rule before the global capability sketch hardens:

- When should a child capability be exposed as a getter/property?
- When should selection or derivation be a method?
- Do we use getters only for stable, zero-argument child capabilities like
  `project.worker`, `project.streams`, `workspace.git`?
- Do we use methods when caller input is required, like `projects.get(id)` and
  `streams.get(address)`?
- Are getters acceptable over Workers RPC given they may hide remote work behind
  property access?

Current recommendation:

- Use methods for all selection, parsing, creation, and anything that accepts
  input.
- Use getters only for stable child capabilities that are pure views over
  already-held authority.
- `project.worker` can be a getter because it is a stable child facade of the
  Project capability, not a dynamic worker transfer.
- `project.streams`, `project.repos`, `project.workspaces`, and `workspace.git`
  can be getters for the same reason.

Resolved rule:

```ts
// methods: selection, parsing, creation, caller input
ctx.projects.get("bla");
ctx.streams.get({ namespace, path });

// getters: stable child capabilities over already-held authority
project.worker;
project.streams;
project.repos;
workspace.git;
```

### Root address shape decision

Repos and Workspaces need admin root addressability without a global D1 listing
index. The address shape decision is whether their root address shape should use
a generic namespace/key convention or an explicit owner union.

Option A:

```ts
ctx.repos.get({ namespace: projectId, slug: "iterate-config" });
ctx.repos.get({ namespace: "global", slug: "iterate-config-base" });
```

Option B:

```ts
ctx.repos.get({ owner: { type: "project", projectId }, slug: "iterate-config" });
ctx.repos.get({ owner: { type: "global" }, slug: "iterate-config-base" });
```

Option C:

```ts
ctx.repos.get({ projectId, slug: "iterate-config" });
ctx.repos.get({ slug: "iterate-config-base" }); // no projectId means global
```

The same idea for Streams would be:

```ts
ctx.streams.get({ namespace, path: "/" });
ctx.streams.get({ path: "/" }); // no namespace means default namespace
```

Decision: reject Option C. Omitted owner fields make call-site meaning depend too
much on context. Repos and Streams should both use an explicit namespace at the
root, and global resources should say `namespace: "global"` or whatever canonical
global namespace we choose.

Additional decision: root namespace selectors are admin-only. User-derived
project access should go through `ctx.projects.get(projectIdOrSlug)` first, then
use project-derived collections that fill the namespace.

Working shape:

```ts
ctx.streams.get({ namespace, path });
ctx.repos.get({ namespace, slug });
ctx.workspaces.get({ namespace, slug });

ctx.streams.get({ namespace: projectId, path: "/" });
ctx.repos.get({ namespace: projectId, slug: "iterate-config" });
ctx.repos.get({ namespace: "global", slug: "iterate-config-base" });
```

The working shape above is for admin-root direct access. Project-derived
collections are the normal user-auth path.

Project-derived collections fill the namespace:

```ts
const project = ctx.projects.get("bla");

project.streams.get({ path: "/" });
project.streams.get("/");
project.repos.get({ slug: "iterate-config" });
project.workspaces.get({ slug: "agent-workspace" });
```

This means each domain has its own namespace term. Avoid collapsing them into a
generic "Domain Namespace" until a real abstraction emerges from implementation.

Prompts:

- What should a root Iterate capability feel like?
- What should an `IterateContext` add on top of that root capability?
- What should code look like for streams, contacts, offices, sandboxes,
  workspaces, agents, and project workers?
- Which calls should be possible from browser UI, codemode, project config
  workers, dynamic workers, Slack tools, and internal processors?
- Where should authorization happen, and what should Durable Objects not need to
  know?

Raw sketches:

```ts
// Examples to edit:
await context.streams.get({ namespace, path }).append({ type, payload });
await context.project.streams.get({ path }).read();
await context.contact.start.streams.get({ namespace, path });
await context.append({ type, payload }); // mounted current stream append?
```

## Goal Of This Note

Ground the OS capability redesign in object-capability ideas and the actual
Cloudflare Workers RPC / Cap'n Web machinery, then turn that into a decision
inventory for the OS app.

The working direction is:

- make every domain object reachable through a small capability surface;
- keep Durable Object code focused on state and commands;
- put authorization, attenuation, mounting, and context shaping in lightweight
  capability wrappers;
- make it obvious how to add a new domain such as `sandboxes`;
- keep the same mental model across oRPC, codemode, Cap'n Web, project workers,
  stream processors, and future browser-facing RPC.

## Research: Object-Capability Grounding

### Capabilities designate and authorize

The core object-capability idea is that a reference is both the way to designate
an object and the authority to use it. There is no separate global name that
anyone can type and then pass through an ACL check. If you do not have the
reference, you cannot invoke the object. If you receive a narrowed reference, you
only have the authority represented by that reference.

OS implication: prefer "give this code a `StreamAppendCapability` for this
stream" over "give this code a global streams client plus a policy check on every
path string".

### Avoid singleton-shaped APIs when object handles are natural

Kenton Varda's Cap'n Proto RPC docs use a filesystem example: a clean distributed
object API has directories and files as handles, while a latency-fearing API
tends to collapse into a singleton `Filesystem` with path strings everywhere.
Promise pipelining exists to keep object-shaped APIs efficient without turning
everything into a global path router.

OS implication: `context.streams.get({ namespace, path }).append(...)` is closer
to the object-capability model than `context.streams.append({ namespace, path,
event })`, if the returned stream handle can be pipelined and attenuated. A
collection method can still exist for convenience, but the core model should be
handle-first where the handle has meaning.

### Authority should be attenuable

An object capability can wrap or attenuate another capability:

- read-only stream handle;
- append-only stream handle;
- current-stream-only handle;
- child-streams handle;
- project-scoped contacts collection;
- contact-scoped streams view;
- user-facing context with only browser-safe operations;
- codemode context with tool providers and egress rules.

OS implication: avoid boolean soup on a singleton. Create distinct wrapper
objects when the authority distinction matters.

### Connectivity creates connectivity

In ocap systems, new connectivity comes from initial endowment, parenthood,
introduction, or explicit delegation. A component should not discover powerful
roots ambiently.

OS implication: `IterateContext` should be constructed from explicit root
authority plus mounts. Project config workers and codemode scripts should not be
able to manufacture broader roots from environment strings.

## Research: Cloudflare / Kenton / Cap'n Web Findings

### Workers RPC and Cap'n Web expose objects by reference

Cap'n Web's README says it is a JavaScript-native object-capability RPC system.
`RpcTarget` instances are passed by reference; the receiver gets a stub. Stubs
can be passed again, including across independent connections. Cap'n Web also
supports bidirectional calls and promise pipelining.

Kenton's Workers RPC launch post shows the same pattern for Workers RPC:
`WorkerEntrypoint` methods can return `RpcTarget` objects, such as a `User`
object returned only after auth succeeds.

OS implication: returning live handles from capability methods is not a hack; it
is the intended model. We should lean into small `RpcTarget` facets rather than
flattening all operations onto collection entrypoints.

### Visibility rules are part of the security boundary

Workers RPC exposes prototype methods and getters on `RpcTarget`,
`WorkerEntrypoint`, and `DurableObject`. It does not expose instance properties.
JavaScript `#private` fields are not exposed. Plain objects are passed by value
and expose their own properties as data.

OS implication:

- capability classes should keep authority-bearing dependencies in `#private`
  fields or constructor-private fields that become instance properties;
- only intentional prototype methods/getters should be public;
- TypeScript `private` is not a security boundary;
- returning plain objects should mean "data", not "authority".

### Stubs have lifetimes

Workers RPC and Cap'n Web both need explicit resource management. Returned
objects containing stubs should usually be held with `using`. Stubs passed as
parameters are auto-disposed when calls return unless duplicated. Kenton's
`rpc_params_dup_stubs` PR changes Workers RPC semantics toward Cap'n Web: params
are duped instead of transferring ownership.

OS implication:

- long-lived capability graphs need explicit ownership rules;
- any registry that stores provided capabilities must decide whether to `dup()`;
- docs and helper APIs should hide most stub lifecycle footguns from ordinary OS
  domain code;
- tests should cover disposal behavior when a capability is retained.

### Promise pipelining favors object-shaped APIs

Kenton's workerd PR for promise pipelining lets callers write dependent calls
without awaiting intermediate handles, such as:

```ts
await root.projects.get(id).streams.get(path).append(event);
```

OS implication: do not reject nested handles purely because of network round
trips. The runtime model is designed to make nested handles viable.

### Proxy-wrapped RpcTargets are now intentional

Kenton's PR fixing Proxy-wrapped `RpcTarget`s says a Proxy can opt an object into
`RpcTarget` behavior by presenting the right prototype. The reasoning is that
the developer is explicitly choosing pass-by-stub semantics and accepting that
the public interface is a security boundary.

OS implication: the current `ProjectWorkerCapability` Proxy pattern is aligned
with Workers RPC direction, but we should keep it a narrow tool. Proxies are good
for ergonomic forwarding, not for hiding unclear authority.

### Cap'n Web and Workers RPC interoperate, but hibernation is not solved yet

Cap'n Web is meant to interoperate with Workers RPC: stubs and promises can move
between the two systems. However, Kenton has said in GitHub issues that Cap'n Web
does not currently handle Durable Object WebSocket hibernation by itself. His
long-term intended shape is:

- terminate the browser Cap'n Web session in a Worker, not directly in a Durable
  Object;
- use Workers built-in RPC from that Worker to Durable Objects;
- make DO-created RPC stubs hibernatable/recreatable;
- let DOs store outbound RPC stubs in a hibernation-surviving space.

OS implication: if OS grows browser-facing capability sessions, avoid making a
Durable Object the direct long-lived Cap'n Web endpoint unless we accept isolate
pinning. A stateless Worker boundary in front of DOs fits Kenton's stated
direction.

### Precedent for the external capability membrane

The research did not find a direct Kenton quote saying "never use an external
RPC stub inside the object's own implementation." The support is architectural:

- Cap'n Proto, Cap'n Web, and Workers RPC distinguish exported capability
  references/stubs from implementation objects.
- Kenton's Cap'n Proto writing frames a capability as an authority-bearing
  reference, not as a requirement that implementation code route through that
  reference.
- Workers RPC stubs are asynchronous boundary-crossing references with lifetimes
  and promise-pipelining behavior.
- Object-capability facets are commonly attenuating wrappers or restricted views
  over an underlying implementation authority.
- The Cloudflare self-hop probe showed same-object Durable Object stubs are real
  subrequests.

OS implication: the rule "RpcTarget capabilities are external facets; Durable
Objects do not use those facets internally" is our local design conclusion. It
matches the model Kenton has been building, even if it is not a quoted platform
law.

## Current OS Capability Shape

Current code already has the start of a good split:

- `apps/os/src/capnweb/iterate-context-capability.ts` builds
  `IterateContext`, `ctx.projects`, and project shortcuts.
- `apps/os/src/capnweb/project-capability.ts` wraps the Project Durable Object
  public surface and adds `project.streams`, `project.repos`,
  `project.workspace`, `project.worker`, and `project.connections`.
- `apps/os/src/domains/*/entrypoints/*-capability.ts` contains domain
  WorkerEntrypoint capabilities bound by props such as `{ projectId }`.
- `apps/os/docs/capability-backed-domain-features.md` says to put
  project-scoped domain behavior in a capability first and keep oRPC thin.

The main asymmetry today:

- Some capabilities are collection facades (`StreamsCapability`,
  `ReposCapability`).
- Some return handles (`ReposCapability.get()` returns `RepoHandle`).
- Streams mostly operate through path-bearing calls rather than a first-class
  `StreamCapability` handle.
- Context mounts are ergonomic shortcuts, but the relationship between "root
  capability", "context", "scope", and "mount" is not yet crisp enough to make
  future domains obvious.

## Candidate Mental Model

### 1. Root authority

`IterateRootCapability` is the maximum internal authority available in a given
runtime. It can derive attenuated roots, project roots, domain collections, and
system handles.

Possible public shape:

```ts
root.projects.get(projectId);
root.streams.namespace(namespace);
root.contacts.get(contactId);
root.offices.get(officeId);
root.sandboxes.get(sandboxId);
```

Question: Is this root ever directly exposed to user code, or does every user
get an attenuated `IterateContext` view?

### 2. Context as a projection, not the authority source

`IterateContext` should be a projection over a root capability plus scope and
mount definitions.

```ts
context.root; // maybe hidden, maybe not exposed
context.project; // shortcut if exactly one project
context.streams; // mounted or scoped collection
context.contacts; // mounted or scoped collection
context.append; // method mount for current stream
```

Question: Should `context.root` be callable, or should context only expose the
attenuated members?

### 3. Domain collection capability

A plural collection is how you select or create domain objects. It should usually
be scoped by project, organization, contact, office, or namespace.

```ts
context.project.streams.get({ path });
context.project.streams.create({ path });
context.contacts.get({ id });
context.sandboxes.create({ slug });
```

Question: Do collection selectors accept identity objects, positional strings,
or both?

### 4. Domain handle capability

A singular handle is the authority to a specific object or facet.

```ts
const stream = context.project.streams.get({ path: "/inbox" });
await stream.read();
await stream.append({ type, payload });
await stream.children.get("thread-1").append(event);
```

Question: Should handles be cheap pure `RpcTarget` wrappers around DO stubs, or
should some handles be actual WorkerEntrypoint loopback services?

### 5. Facets for attenuation

Use distinct wrappers for different powers:

```ts
stream.reader();
stream.appender();
stream.children();
repo.description();
repo.writer();
contact.profile();
contact.streams();
```

Question: Should facets be explicit method names, properties, or constructor
functions in a capability factory?

### 6. Mounts as local names

Mounts should never grant authority. They should bind an already-authorized
target to a convenient path.

```ts
context.append(event)      // mounted to currentStream.append
context.workspace.git      // mounted to project workspace git
context.slack.chat.postMessage(...)
```

Question: Are mounts a feature of `IterateContextProps`, a feature of
capability wrappers, or both?

## Candidate API Shapes To Compare

### Shape A: Current style, collection operations carry identity

```ts
await ctx.streams.append({ namespace, path, event });
await ctx.project.streams.read({ path });
```

Pros:

- simple to serialize;
- maps closely to current `StreamsCapability`;
- easy oRPC adapter.

Cons:

- path/namespace strings stay in every operation;
- harder to pass "only this stream" authority;
- authorization logic tends to repeat in collection methods.

### Shape B: Handle-first

```ts
const stream = ctx.streams.get({ namespace, path });
await stream.append(event);
await stream.read();
```

Pros:

- reference itself carries authority;
- easy to attenuate and delegate;
- aligns with Cap'n Proto / Cap'n Web model;
- promise pipelining makes nesting viable.

Cons:

- requires careful stub lifetime management;
- needs a naming convention for collection vs handle;
- browser/oRPC adapters may still want flat operations.

### Shape C: Scope builders

```ts
const project = ctx.projects.get(projectId);
const stream = project.streams.path("/work").get();
await stream.append(event);

const contact = ctx.contacts.get(contactId);
await contact.streams.path("/timeline").append(event);
```

Pros:

- fluent and discoverable;
- separates namespace/scope selection from object operations;
- can be pipelined.

Cons:

- builder objects can become too clever;
- harder to keep file/class naming obvious;
- may obscure when durable state is created.

### Shape D: Context-local mounts for active object

```ts
await ctx.append(event);
await ctx.read();
await ctx.children.get("child").append(event);
```

Pros:

- excellent inside a stream processor or codemode session;
- makes "current object" workflows concise.

Cons:

- dangerous if mounts are not visible/debuggable;
- can hide which authority is being used;
- needs strong introspection and trace output.

Likely answer: use Shape B as the conceptual core, Shape A as oRPC adapter where
needed, Shape D only for explicit local execution contexts, and use Shape C
sparingly if it improves namespace clarity.

## Long List Of Design Decisions

### Authority roots

- What is the smallest root authority object?
- Is there exactly one `IterateRootCapability`, or separate root facets for
  admin, organization, project, user, codemode session, and processor?
- Should `IterateContext` always contain a root, or only derived members?
- Is project authority always derived from `root.projects.get(id)`, including
  project ingress?

### Scopes

- Are scopes only project scopes, or do they become a general authority
  descriptor?
- Should scopes be data (`{ projects: [...] }`) or actual capabilities
  (`ProjectCapability[]`)?
- Does `scopes` grant reachability, while `mounts` only rename reachable things?
- Should code be able to inspect its scopes?

### Identity

- What are the identity axes: project, organization, namespace, path, contact,
  office, sandbox, agent, repo, workspace, stream?
- Which identities are durable product IDs vs local capability paths?
- Should `namespace` be a first-class object or just a string prop?
- Should stream paths be relative once you hold a namespace or parent stream?

### Collection vs handle

- For each domain, what is the plural collection?
- For each domain, what is the singular handle?
- Which methods create durable state?
- Which methods only select existing state?
- Should `get()` fail if missing and `create()` be the only creation operation?
- Should `open()` mean "select or create" anywhere, or is that too ambiguous?

### Durable Object simplicity

- Which DO methods are internal command/state methods?
- Which DO methods are directly safe to expose over RPC?
- Should DO classes avoid extending public API shape beyond operational commands?
- Should capability wrappers be the only public boundary for auth checks?
- Do we need a lint or convention that public DO methods are not user-facing by
  default?

### Capability wrapper shape

- Should every wrapper extend `RpcTarget`?
- Should WorkerEntrypoint capabilities only be collection roots, while `RpcTarget`
  wrappers are handles/facets?
- Should wrappers hold raw DO stubs in private fields?
- Should wrappers be pure and synchronous to construct?
- Where do wrappers live: `domains/{domain}/capabilities`, `entrypoints`, or
  `capnweb`?

### Naming

- Is the file `streams-capability.ts`, `stream-capability.ts`,
  `stream-handle.ts`, or `stream-facets.ts`?
- Should collection classes be plural (`StreamsCapability`) and handle classes be
  singular (`StreamCapability`)?
- Should attenuated classes include the power:
  `StreamReadCapability`, `StreamAppendCapability`?
- Should Cap'n Web wrapper names differ from domain WorkerEntrypoint names?
- What should "context capability" mean versus "root capability"?

### Authorization

- Is authorization checked when deriving a handle, when invoking a method, or
  both?
- Should a handle capture an authorization decision at creation time, or recheck
  live policy on each call?
- Which policies are static by construction, and which are dynamic?
- How do revoked permissions affect existing stubs?
- Do we need revocable wrappers for user-facing or long-lived sessions?

### Revocation and expiry

- Can a capability expire?
- Can a parent revoke child capabilities?
- Do we need caretaker/revoker pairs?
- How do we invalidate browser-held or codemode-held stubs?
- What is the behavior when a project membership changes mid-session?

### Delegation

- Can codemode pass a capability to a project worker?
- Can a project worker provide a capability back to OS?
- Can one project expose a capability to another project?
- Should cross-project sharing be impossible initially?
- How do we audit delegated capability graphs?

### Mounting

- Are mounts resolved eagerly or lazily?
- Can a mount target be a capability, a method, or a dynamic-worker script?
- Can mounts be nested under domain objects, not just context roots?
- How does `context.append` explain that it is actually
  `context.streams.get(current).append`?
- Should mounted paths appear in `context.describe()`?

### Browser-facing sessions

- Should browser UI use Cap'n Web directly, or stay on oRPC for now?
- If browser uses Cap'n Web, is the session terminated in the app Worker?
- Which capabilities are browser-safe?
- How do we integrate first-party auth and organization/project claims?
- How do we prevent a browser session from pinning Durable Object isolates?

### Codemode and tool providers

- Do codemode Tool Providers remain separate from the root capability tree?
- Should provider registrations be generated from capabilities?
- Should every codemode tool path correspond to a mounted capability path?
- How much instruction text belongs in capability definitions?
- Can codemode receive live handles safely, and who disposes them?

### oRPC

- Which APIs stay flat for browser/API ergonomics?
- Should every oRPC project router adapt through the same domain capability that
  codemode uses?
- How do oRPC errors map from capability errors without string matching?
- Should oRPC ever expose handle-like sessions, or stay request/response?

### Streams specifically

- Is `namespace` always project ID, or will contacts/offices/sandboxes define
  their own namespaces?
- Is `StreamCapability` selected by `{ namespace, path }`, or by a
  `StreamAddress` value object?
- Should `ctx.project.streams.get({ path })` be sugar over
  `ctx.streams.get({ namespace: project.id, path })`?
- Should current stream context mount `append`, `read`, `children`, or
  `stream`?
- Does `appendPolicy` become a wrapper class rather than a prop?

### Contacts / offices / future domains

- What is the expected symmetry?
- Does every domain get:
  - collection capability;
  - singular capability;
  - optional handle facets;
  - oRPC adapter;
  - codemode provider registration;
  - Cap'n Web context mount?
- Which domains are project-owned vs organization-owned vs global?

### Lifecycle and hibernation

- Which capabilities may be long-lived?
- Which handles are cheap derivations that can be reconstructed?
- Which handles hold isolate-local state and therefore risk hibernation?
- Do we need a stateless Worker proxy boundary for all browser Cap'n Web
  sessions?
- What is the migration path if Workers adds hibernatable `RpcTarget`s?

### Testing

- Can each capability have unit tests with fake DO stubs?
- Do we need e2e tests proving object handles pipeline correctly?
- Do we need tests for mount leakage between contexts?
- Do we need tests proving unauthorized paths cannot be reached by passing
  strings?
- Do we need disposal/dup tests for provided capabilities?

### Introspection and debugging

- Should every capability implement `describe()`?
- Should `context.describe()` show scopes, mounts, and available roots?
- Should capability calls emit structured logs with capability type and authority
  descriptor?
- How do we debug "why does this context have authority to call X?"
- Can traces show capability derivation chains without leaking secrets?

## Strawman File And Class Convention

Transition sketch: prove the model in a fake prototype domain before migrating
the real Project/Repo/Stream/Workspace code.

```text
apps/os/src/domains/
  capability.ts                 # root IterateCapability
  capability-auth.ts
  capability-policy.ts

apps/os/src/domains/capability-prototype/
  capability.ts                 # FakeProjectsCapability, FakeProjectCapability
  durable-object.ts             # FakeProjectDurableObject, FakeStreamDurableObject
  entrypoint.ts                 # optional WorkerEntrypoint export wrapper
  utils.ts                      # one-line name helpers, constants
  capability.test.ts
```

Use fake names in the spike so the prototype cannot collide with existing
exports:

```ts
export class FakeProjectsCapability extends RpcTarget { ... }
export class FakeProjectCapability extends RpcTarget { ... }
export class FakeStreamsCapability extends RpcTarget { ... }
export class FakeStreamCapability extends RpcTarget { ... }

export class FakeProjectDurableObject extends DurableObject { ... }
export class FakeStreamDurableObject extends DurableObject { ... }
```

The prototype should prove:

- untrusted callers enter through a root capability;
- authorization happens in capability classes only;
- Durable Objects are auth-blind and do not import capabilities;
- Durable Objects can call other Durable Objects directly with raw stubs;
- raw `PROJECT` / `REPO` / `STREAM` / `WORKSPACE` binding access is linted.

Lint boundary: `iterate/no-raw-durable-object-binding-access` is enabled as an
error in `.oxlintrc.json`. It forbids raw
`PROJECT.getByName(...)` / `REPO.getByName(...)` /
`STREAM.getByName(...)` / `WORKSPACE.getByName(...)` outside allowed capability
and trusted domain-internal paths. The first allowlist is transitional:
capability files, entrypoints, Durable Object internals, `worker.ts`, and
the current `capnweb` compatibility layer.

## Initial Recommendations / Biases

- Use handle-first capability APIs as the conceptual model.
- Keep flat collection operations only as adapters or convenience methods.
- Make plural classes collections and singular classes handles.
- Keep Durable Object methods simple and not automatically public product APIs.
- Put authorization and attenuation in domain-local `capability.ts` files around
  DO stubs.
- Treat `IterateContext` as a scoped projection over root authority plus mounts.
- Make mounts introspectable.
- Use explicit facet classes when authority differs.
- Avoid long-lived browser-to-DO Cap'n Web sessions for now; terminate browser
  Cap'n Web in a Worker if/when we introduce it.
- Write a small "capability vocabulary" doc before changing more code:
  root, context, scope, mount, collection, handle, facet, authority,
  attenuation, delegation, revocation.

## Source Notes

- Cap'n Proto RPC protocol:
  https://capnproto.org/rpc.html
  - Promise pipelining is presented as the reason object-shaped distributed APIs
    can stay efficient.
  - Interface references are capabilities: they designate an object and confer
    permission to call it.

- Cloudflare Cap'n Web README:
  https://github.com/cloudflare/capnweb
  - Cap'n Web is a JavaScript-native object-capability RPC system.
  - `RpcTarget` instances are passed by reference as stubs.
  - It supports bidirectional calls, promise pipelining, stub passing, and
    Cap'n Web / Workers RPC interoperability.

- Cloudflare Cap'n Web blog:
  https://blog.cloudflare.com/capnweb-javascript-rpc-library/
  - Cap'n Web uses JSON-based serialization plus an RPC protocol inspired by
    Cap'n Proto.
  - The protocol is symmetric: both sides can expose and call objects.

- Kenton Varda, Workers JavaScript-native RPC blog:
  https://blog.cloudflare.com/javascript-native-rpc/
  - Shows returning `RpcTarget` objects as authority-bearing handles after an
    auth check.
  - Reinforces that instance fields are not exposed over RPC; class prototype
    methods are.

- Workers RPC visibility and security docs:
  https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
  - Workers RPC is intended for safe communication between mutually untrusted
    Workers.
  - Only explicitly received stubs/functions can be invoked.
  - Prototype methods/getters are visible; instance properties are hidden for
    `RpcTarget`, `WorkerEntrypoint`, and `DurableObject`.

- Workers RPC lifecycle docs:
  https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
  - Stubs consume remote memory.
  - Use explicit disposal / `using`.
  - Use `dup()` when retaining or passing stubs beyond an automatic disposal
    boundary.

- Kenton Varda, workerd PR #1692:
  https://github.com/cloudflare/workerd/pull/1692
  - Introduced `RpcTarget` for non-entrypoint RPC objects sent in messages.
  - Notes resource management and promise pipelining as necessary follow-up
    pieces.

- Kenton Varda, workerd PR #1729:
  https://github.com/cloudflare/workerd/pull/1729
  - Adds property access and promise pipelining using custom thenables.

- Kenton Varda, workerd PR #3212:
  https://github.com/cloudflare/workerd/pull/3212
  - Makes Proxy-wrapped `RpcTarget`s work.
  - Says Proxy opt-in to `RpcTarget` behavior is a feature because it explicitly
    opts into pass-by-stub semantics and public-interface-as-security-boundary.

- Kenton Varda, workerd PR #4719:
  https://github.com/cloudflare/workerd/pull/4719
  - Enables interoperability with pure-JS Cap'n Web by making pure-JS `RpcStub`
    extend `RpcTarget`.

- Kenton Varda, workerd PR #5733:
  https://github.com/cloudflare/workerd/pull/5733
  - Adds `rpc_params_dup_stubs` to make Workers RPC parameter stub ownership
    match Cap'n Web: params are duplicated rather than transferred.

- Cap'n Web issue #36:
  https://github.com/cloudflare/capnweb/issues/36
  - Kenton says Cap'n Web does not currently support WebSocket hibernation.
  - He describes the intended long-term architecture: browser Cap'n Web session
    terminates in a Worker, Worker uses built-in RPC to DOs, and Workers runtime
    eventually supports hibernatable RPC targets and persisted outbound stubs.

- workerd issue #6087:
  https://github.com/cloudflare/workerd/issues/6087
  - Tracks hibernatable RPC targets in Workers Runtime.
  - Kenton confirms this is planned but a large project.

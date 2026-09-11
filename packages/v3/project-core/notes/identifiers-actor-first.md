# Actor-first identifiers: durable references, live Cap'n Web capabilities

**Status: unimplemented design fork.** Do not treat a context path,
itx-expression string, DO name, URL, and RPC stub as competing spellings of
one identity.

```text
ActorRef: act_01J...  durable logical identity
Path:     /support    mutable human alias
URL:      https://…   HTTP locator
Grant:    signed      attenuated authority
                         │ resolve
                         ▼
                    fresh RpcStub<T>
```

An `RpcStub`, WebSocket, loaded isolate and facet instance are physical and may
go away. A Durable Object's **ID and durable storage survive eviction**, but it
is still Cloudflare placement identity, not a portable application actor
identity. Persist references; resolve a fresh capability per bounded operation.

## The small, deep module: `ActorDirectory`

This one interface hides aliases, authorization, revocation, placement,
dynamic loading, and hibernation. It prevents every caller from learning five
identifier systems.

```ts
import { RpcTarget, type RpcStub } from "capnweb";

declare const actorBrand: unique symbol;
declare const refBrand: unique symbol;
export type ActorId = `act_${string}` & { readonly [actorBrand]: never };
export type ActorRef = Readonly<{
  version: 1;
  project: string;
  actor: ActorId;
  generation?: number;
}> & { readonly [refBrand]: never };
export type ContextPath = `/${string}`;
export type CapabilityName = "stream.read" | "stream.append" | "worker.invoke" | "fetch";
export type Caveat =
  | { kind: "path-prefix"; prefix: ContextPath }
  | { kind: "origins"; values: readonly string[] }
  | { kind: "max-calls"; count: number }
  | { kind: "until"; time: number };
export type Grant = Readonly<{
  version: 1;
  issuer: string;
  subject: ActorRef;
  allows: readonly CapabilityName[];
  caveats: readonly Caveat[];
  epoch: number;
  nonce: string;
  proof: string;
}>;

/** `T` is static help; the descriptor's wire schema is runtime truth. */
export type Capability<T extends RpcTarget> = Readonly<{
  name: string;
  wireHash: `sha256:${string}`;
  methods: Record<string, { input: JsonSchema; result: JsonSchema | { capability: string } }>;
}>;

export interface ActorDirectory {
  lookup(project: string, path: ContextPath): Promise<ActorRef>;
  resolve<T extends RpcTarget>(
    ref: ActorRef,
    grant: Grant,
    expected: Capability<T>,
  ): Promise<RpcStub<T>>;
}
```

These are design sketches, not drop-in runnable declarations. The wire parser
validates canonical JSON, lengths, IDs, signatures and schema hashes. `as
ActorRef` and `as Capability<Foo>` only fool TypeScript; they cannot pass
`resolve()`.

The private record names durable meaning, not current execution:

```ts
type ActorRecord = Readonly<{
  id: ActorId;
  project: string;
  generation: number;
  declaration:
    | { kind: "stream"; stream: `str_${string}` }
    | { kind: "worker"; definition: WorkerDefinitionRef; state: "stateless" }
    | { kind: "worker"; definition: WorkerDefinitionRef; state: "durable"; placementKey: string }
    | { kind: "facet"; parent: ActorId; name: string; definition: WorkerDefinitionRef };
  contracts: readonly { name: string; wireHash: `sha256:${string}` }[];
  grantEpoch: number;
  revokedAtOffset?: number;
}>;
type WorkerDefinitionRef = Readonly<{
  repo: string;
  revision: `sha256:${string}`;
  entrypoint?: string;
}>;
```

## Paths and URLs remain useful, but never become authority

Paths are aliases for people, config and ingress:

```ts
await directory.lookup("acme", "/support/inbox");
// { project: "acme", actor: "act_01JQQ...", generation: 3 }

await root.append({
  id: crypto.randomUUID(),
  type: "alias.moved",
  data: { path: "/support/inbox", from: "act_01JOLD...", to: "act_01JQQ..." },
  provenance: { parents: [], signatures: [adminSignature] },
});
```

The old `ActorRef` still means the old actor. The alias means whatever the last
authorized alias event says. Thus a 2026 invoice can keep its stable subject
after `/billing` moves to a redesigned role.

```text
https://core.example/p/acme/a/act_01JQQ...   stable actor locator
https://core.example/p/acme/c/support/inbox  alias locator
```

Neither URL is a bearer capability. A `?token=` grant leaks into histories,
referrers, logs, screenshots and copied messages. An authenticated session
introduces a short-lived grant in a header or RPC handshake.

## Ordinary TypeScript capabilities, not a durable JavaScript-ish language

There is no reason to preserve `itx.workers.get()` as sacred syntax. The
surface should be normal typed Cap'n Web. `RpcTarget` is intentional: a
structural interface or optional marker is not enough for the runtime target
brand.

```ts
abstract class Invoice extends RpcTarget {
  abstract authorize(input: {
    paymentMethod: string;
  }): Promise<{ id: string; status: "approved" | "declined" }>;
}
abstract class Billing extends RpcTarget {
  abstract open(input: { customer: string; amount: number }): Promise<Invoice>;
}
const BillingContract: Capability<Billing> = capability(Billing, {
  name: "com.acme.billing/v1",
  methods: {
    open: rpc.method({
      input: z.object({ customer: z.string(), amount: z.number().int().positive() }),
      result: rpc.capability("com.acme.invoice/v1"),
    }),
  },
});
abstract class Project extends RpcTarget {
  abstract context(path: ContextPath): Promise<Context>;
}
abstract class Context extends RpcTarget {
  abstract actor<T extends RpcTarget>(ref: ActorRef, expected: Capability<T>): Promise<RpcStub<T>>;
}

// Dependent calls pipeline: no generic `invoke(["open"], ...)` is exposed.
const invoice = project
  .context("/sales")
  .actor(billingActor, BillingContract)
  .open({ customer: "cus_7", amount: 2_500 });
const authorization = await invoice.authorize({ paymentMethod: "pm_9" });
```

`context()` and `actor()` return genuine server-side `RpcTarget`s. That, not a
particular ITX spelling, is the Cap'n Web property worth keeping. An already
scoped project may simply expose `project.actor(ref, contract)`.

For discovery-driven MCP/OpenAPI use one honest dynamic door:

```ts
abstract class DynamicToolset extends RpcTarget {
  abstract list(): Promise<readonly { name: string; inputSchema: JsonSchema }[]>;
  abstract call(name: string, input: unknown): Promise<unknown>;
}
```

Persist a bounded selector AST, not JavaScript punctuation. A compatibility
facade may print friendly expressions, but the AST is durable truth:

```ts
type Selector =
  | { kind: "alias"; path: ContextPath }
  | { kind: "actor"; ref: ActorRef }
  | { kind: "definition"; ref: WorkerDefinitionRef };
type Invocation = { target: Selector; method: string; args: readonly JsonValue[] };

const processor: Invocation = {
  target: { kind: "alias", path: "/agents/digest" },
  method: "processEvent",
  args: [{ afterOffset: 41, throughOffset: 60 }],
};
```

The kernel validates every tag, method, argument size and grant at resolution.

## Three identities; dynamic-worker admission is another layer

```text
bundle digest        sha256(canonical modules)      "which bytes execute?"
wire-contract hash   sha256(canonical RPC manifest) "which calls are compatible?"
actor id             random act_...                 "which durable role is it?"
```

Never use a loader cache key as public identity. A code-only patch can change
the bundle digest while retaining a contract. A declared compatible contract
evolution also must not silently replace a durable actor.

Build/bundle/admission occurs before `resolve()`:

```ts
export default expose(
  BillingContract,
  class extends Billing {
    async open(input) {
      return new InvoiceImpl(input);
    }
  },
);

// `project-core build` emits this from pinned source, then signs/publishes it.
const manifest = {
  bundleDigest: "sha256:4a1e...",
  contracts: [{ name: "com.acme.billing/v1", wireHash: "sha256:7d22..." }],
};
await project.definitions.publish({ source: pinnedRevision, manifest });
await project.actors.bind(billingActor, {
  definition: pinnedRevision,
  contract: { name: BillingContract.name, wireHash: BillingContract.wireHash },
});
```

The builder rejects missing exposed methods, unserializable schemas, unpinned
imports, and a descriptor inconsistent with the emitted manifest. A deployed
contract test handles what TypeScript cannot:

```ts
test("billing actually conforms to its registered contract", async () => {
  const billing = await deployed.context("/sales").actor(billingActor, BillingContract);
  await expect(billing.open({ customer: "cus_test", amount: 0 })).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(billing.open({ customer: "cus_test", amount: 2_500 })).resolves.toBeDefined();
});
```

## Saving, hibernating, revoking

Persist `ActorRef` / selector / declaration, never an `RpcStub`:

```ts
await root.append({
  id: crypto.randomUUID(),
  type: "subscription.created",
  data: { target: { kind: "actor", ref: billingActor }, invoke: processor },
  provenance: { parents: [], signatures: [configSignature] },
});
// wrong: a stub is a live connection, not durable data
await root.append({ id: crypto.randomUUID(), type: "bad", data: { target: billingStub } });
```

For each delivery the Context resolves the reference with its narrow current
grant, uses the fresh stub for that bounded operation, then disposes it. A
browser-provided callback is different: persist only a random rendezvous key
and epoch; page an edge holder over a hibernatable WebSocket; lend a fresh
native wrapper. Reconnect restores liveness, never a revoked grant or old stub.

`resolve()` atomically checks canonical ref, project/generation, actor
revocation, grant signature/expiry/subject/caveats/epoch, wire-contract hash,
and allowed method. A one-shot caveat reserves use durably before an effect. So
one actor can have an egress grant for `api.mail.example` and a read-only stream
grant without minting separate actors or embedding power in its path.

## Cloudflare adapter and trade-off

The adapter may encode `{ project, actor, generation }` into a named DO and
open a scoped `ctx.exports` entrypoint. It must not expose the namespace, raw
DO name, raw bindings, or a general reflection door. A facet is normally a
private derived child `{ parent, name, definition }`; promote it only when it
needs independent addressing/authority.

This costs a directory lookup and grant check per resolution, plus an
alias/history inspector. Cache immutable declarations, never authorization past
expiry/epoch. It is overkill for a single root stream with no durable references
or independently governed actors; there a canonical path plus scoped entrypoint
is the better deep module.

## Source basis

- Cap'n Web: [`RpcTarget` is pass-by-reference and own properties are hidden](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L221-L245), [dependent calls pipeline through `RpcPromise`](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L257-L301), and [stubs have a disposal/breakage lifetime](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L367-L400).
- Workerd: [`DurableObjectNamespace` separates unique IDs, name-derived IDs and `get`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L535-L561); [`ctx.exports` loopback construction is capability-scoped](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/export-loopback.h#L13-L66).
- Cloudflare OS: [`loadGadgetWorker()` snapshots code identity before asynchronous loading](https://github.com/cloudflare/cloudflare-os/blob/81f3c57/packages/workshop-backend/src/overseer.ts#L3960-L4040), keeping immutable code identity distinct from cached physical execution.
- Existing [`context/expression.ts`](../../project-worker/src/context/expression.ts) already has string and structured forms; this fork retains only constrained structured durable data.

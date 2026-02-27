# Service Abstraction Design

Living document. Tracks the design of the service abstraction for Iterate deployments.

## What is a service?

A **service** is a named, network-addressable unit of compute that:

- Receives HTTP traffic routed through Caddy
- Is addressable at `{slug}.iterate.localhost` (always, by convention)
- Describes its API via a committed `openapi.json`
- Self-registers with a **registry service** on startup
- Declares a typed **config schema** ("here's what I need to run")
- Is topology-agnostic — can run anywhere with a network path to registry + Caddy

A service's external representation is exactly two things:

1. A hostname you can address (with ports — default 80)
2. An OpenAPI spec describing what HTTP requests it accepts

## ServiceDefinition

The canonical type describing what a service *is*:

```typescript
interface ServiceDefinition<
  TContract extends AnyContractRouter = AnyContractRouter,
  TConfigSchema extends z.ZodType = z.ZodType,
> {
  /** Unique identifier. Used in hostnames, file paths, registry keys. kebab-case. */
  slug: string;

  /** Human-readable name */
  name: string;

  /** Semver */
  version: string;

  /** Default port when running locally (used for URL resolution fallback) */
  port: number;

  /** The oRPC contract this service implements */
  contract: TContract;

  /**
   * Typed config schema — what this service needs to run.
   * NOT env vars. The registry provides values for this schema.
   * Think of it as the service's "constructor parameters".
   */
  configSchema: TConfigSchema;

  /** Capabilities / metadata */
  capabilities: {
    /** Should Caddy route public internet traffic to this service? */
    publicTraffic?: boolean;

    /** Does this service have a SQLite DB that should appear in the viewer? */
    sqliteDb?: {
      path: string;
    };

    /** Path where openapi.json is served at runtime (for docs aggregation) */
    openapiPath?: string;
  };
}
```

### Key design decisions

**Contract vs ServiceDefinition:** A contract is a pure API shape — it carries no identity. A ServiceDefinition *binds* a contract to an identity (slug, port, config). Two services CAN implement the same contract with different slugs. The contract is "what can I do?", the definition is "who am I and what do I need?".

**When a caller depends on a service**, it depends on:
- The **contract** (for type safety)
- The **slug** (for addressing — "I want to talk to the orders service specifically")

This means clients are constructed from `(contract, slug)` — not from the full ServiceDefinition. The ServiceDefinition is used by the *service itself* and by the *registry*.

**Config schema replaces env vars.** Today, services declare `envVars: z.object({...})` in their manifest and parse `process.env` at startup. Instead, the service should declare a config schema, and the registry provides the values. The service still *receives* them as env vars (or a config object), but the source of truth is the registry, not `.env` files.

## Registration protocol

On startup, a service:

1. Knows exactly one thing: the registry base URL (env var: `REGISTRY_URL`)
2. Sends a `register` request with:
   ```typescript
   {
     slug: string;
     version: string;
     host: string;          // where Caddy can reach me (e.g. "127.0.0.1:19020")
     configSchema: object;  // JSON Schema of what I need
     capabilities: { ... }; // from ServiceDefinition
     openapiSpec?: object;  // the full openapi.json (or URL to fetch it)
   }
   ```
3. Registry responds with:
   ```typescript
   {
     config: Record<string, unknown>;  // values matching configSchema
     caddy: { configured: boolean };   // confirmation that routing is set up
   }
   ```
4. Service applies config and signals ready

On shutdown (or crash detection), the service deregisters.

## Lifecycle

```
[start] → know REGISTRY_URL
       → POST /register { slug, version, host, configSchema, capabilities, openapiSpec }
       ← { config, caddy }
       → apply config
       → signal ready (start accepting traffic)
       ...
       → POST /deregister { slug }
       ← ack
[stop]
```

## Client construction

Today:
```typescript
const client = createOrpcRpcServiceClient({
  env: { ITERATE_PROJECT_BASE_URL: "..." },
  manifest: ordersServiceManifest,  // { slug, port, orpcContract }
});
```

This is roughly right. The manifest is the ServiceDefinition minus config. We should formalize this:

```typescript
// What a caller needs to create a client
interface ServiceRef<TContract extends AnyContractRouter> {
  slug: string;
  port: number;
  contract: TContract;
}
```

A ServiceDefinition produces a ServiceRef by dropping config/capabilities. The contract package exports both.

### Same contract, different services

If `service-a` and `service-b` both implement `widgetContract`:

```typescript
// widget-contract package exports the contract
export const widgetContract = oc.router({ ... });

// service-a-contract package
export const serviceARef: ServiceRef<typeof widgetContract> = {
  slug: "service-a",
  port: 19100,
  contract: widgetContract,
};

// service-b-contract package
export const serviceBRef: ServiceRef<typeof widgetContract> = {
  slug: "service-b",
  port: 19101,
  contract: widgetContract,
};
```

Callers choose which to talk to by importing the right ServiceRef.

## Committed openapi.json

Design goal: `openapi.json` files are committed in the repo, not just generated at runtime.

Approach:
- Each service contract package has a script: `pnpm generate:openapi`
- This script imports the contract, uses `@orpc/openapi` to generate the spec, writes to `services/{slug}-contract/openapi.json`
- CI verifies specs are up-to-date (generate + diff)
- Other services/tools can import the committed spec for codegen, docs, etc.

## Open questions / future work

- [ ] **Auth between service ↔ registry.** Bearer token? mTLS? For now, same-machine trust is fine.
- [ ] **Config distribution details.** Does the registry push config updates, or does the service poll? What about config changes after initial registration?
- [ ] **Service discovery beyond Caddy.** Currently Caddy is the only router. What if a service needs to discover another service without going through Caddy? (Answer for now: use the port-based URL resolution, which already works.)
- [ ] **OpenAPI client generation.** We want typed oRPC-wrapped clients auto-generated from committed specs. What's the toolchain? `@orpc/openapi` can generate specs; can it also consume them to produce clients? Or do we use a separate codegen tool?
- [ ] **Third-party / non-oRPC services.** The abstraction should work for any HTTP service with an OpenAPI spec, not just our TS/oRPC ones. The registration protocol is HTTP-based and contract-agnostic — the oRPC contract is a TS-specific nicety on top.
- [ ] **Same-contract-different-service naming.** How do we name the packages? `widget-contract` for the shared contract, `service-a-definition` for the identity binding? Or just `service-a` exports both its definition and re-exports the contract?
- [ ] **Migration path from current manifests.** The existing `ordersServiceManifest` etc. need to evolve into `ServiceDefinition`. Should be incremental — rename fields, add configSchema, deprecate envVars.

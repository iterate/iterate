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

The canonical type. A service definition is a **TS package** that exports this shape:

```typescript
interface ServiceDefinition<
  TContract extends AnyContractRouter = AnyContractRouter,
  TConfig extends z.ZodType = z.ZodType,
> {
  /** Unique identifier. Used in hostnames, file paths, registry keys. kebab-case. Also the human-readable name. */
  slug: string;

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
  configSchema: TConfig;

  /** Path to a SQLite DB that should appear in the viewer, if any */
  sqliteDbPath?: string;

  /** Path where openapi.json is served at runtime (for docs aggregation) */
  openapiPath?: string;

  /**
   * Start the service. Receives parsed, validated config.
   * Returns a handle with a stop() function for graceful shutdown.
   *
   * For TS/oRPC services: sets up Hono, mounts handlers, registers with registry, listens.
   * For non-TS services: converts config to env vars, spawns subprocess.
   */
  start(config: z.infer<TConfig>): Promise<ServiceHandle>;
}

interface ServiceHandle {
  /** Graceful shutdown */
  stop(): Promise<void>;
}
```

### Why a package with start()?

Every service — even non-TS ones — gets a thin TS definition package. This gives us:

- **Uniform entrypoint.** Pidnap, registry, test harnesses all call `start()`. No separate "how to run this" config.
- **Typed config pipeline.** Config schema is Zod (TS anyway). `start()` receives parsed, validated config. No more raw env var parsing in each service.
- **Adapter layer for non-TS services.** The `start()` function can convert typed config to env vars and spawn a child process. The wrapper is tiny.

```typescript
// Example: wrapping a non-TS service
export default defineService({
  slug: "outerbase",
  port: 19040,
  configSchema: z.object({ dbUrl: z.string() }),
  async start(config) {
    const proc = spawn("outerbase-server", {
      env: { DATABASE_URL: config.dbUrl, PORT: String(this.port) },
    });
    return { stop: () => proc.kill() };
  },
});

// Example: TS/oRPC service
export default defineService({
  slug: "orders",
  port: 19020,
  contract: ordersContract,
  configSchema: z.object({
    dbPath: z.string(),
    eventsServiceUrl: z.string(),
  }),
  async start(config) {
    const db = createDb(config.dbPath);
    const app = new Hono();
    // mount handlers...
    const server = serve({ fetch: app.fetch, port: this.port });
    await registerWithRegistry(this);
    return { stop: () => server.close() };
  },
});
```

### Key design decisions

**Contract vs ServiceDefinition:** A contract is a pure API shape — it carries no identity. A ServiceDefinition *binds* a contract to an identity (slug, port, config, start logic). Two services CAN implement the same contract with different slugs. The contract is "what can I do?", the definition is "who am I, what do I need, and how do I start?".

**When a caller depends on a service**, it depends on:
- The **contract** (for type safety)
- The **slug** (for addressing — "I want to talk to the orders service specifically")

This means clients are constructed from `(contract, slug)` — not from the full ServiceDefinition. The ServiceDefinition is used by the *service itself* and by the *registry*.

**Config schema replaces env vars.** Today, services declare `envVars: z.object({...})` in their manifest and parse `process.env` at startup. Instead, the service declares a config schema, and the registry provides the values. The `start()` function receives parsed config — no more `process.env` parsing scattered across services.

## ServiceRef (for callers)

What a caller needs to create a client — the minimum projection of a ServiceDefinition:

```typescript
interface ServiceRef<TContract extends AnyContractRouter> {
  slug: string;
  port: number;
  contract: TContract;
}
```

A ServiceDefinition naturally satisfies ServiceRef. The definition package exports both the full definition and the ref.

### Same contract, different services

If `service-a` and `service-b` both implement `widgetContract`:

```typescript
// widget-contract package exports the contract
export const widgetContract = oc.router({ ... });

// service-a definition package
export const serviceA = defineService({
  slug: "service-a",
  port: 19100,
  contract: widgetContract,
  // ...
});

// service-b definition package
export const serviceB = defineService({
  slug: "service-b",
  port: 19101,
  contract: widgetContract,
  // ...
});
```

Callers import the definition they want and use it as a ServiceRef for client construction.

## Registration protocol

On startup, `start()` calls the registry:

1. Knows exactly one thing: the registry base URL (env var: `REGISTRY_URL`)
2. Sends a `register` request with:
   ```typescript
   {
     slug: string;
     version: string;
     host: string;          // where Caddy can reach me (e.g. "127.0.0.1:19020")
     configSchema: object;  // JSON Schema of what I need
     openapiSpec?: object;  // the full openapi.json (or URL to fetch it)
     sqliteDbPath?: string;
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
[start()] → know REGISTRY_URL
          → POST /register { slug, version, host, configSchema, ... }
          ← { config, caddy }
          → apply config, set up server, mount handlers
          → start accepting traffic
          ...
          → stop() called
          → POST /deregister { slug }
          ← ack
[stopped]
```

## Committed openapi.json

Design goal: `openapi.json` files are committed in the repo, not just generated at runtime.

Approach:
- Each service definition package has a script: `pnpm generate:openapi`
- This script imports the contract, uses `@orpc/openapi` to generate the spec, writes to `services/{slug}/openapi.json`
- CI verifies specs are up-to-date (generate + diff)
- Other services/tools can import the committed spec for codegen, docs, etc.

## Open questions / future work

- [ ] **Auth between service ↔ registry.** Bearer token? mTLS? For now, same-machine trust is fine.
- [ ] **Config distribution details.** Does the registry push config updates, or does the service poll? What about config changes after initial registration?
- [ ] **Service discovery beyond Caddy.** Currently Caddy is the only router. What if a service needs to discover another service without going through Caddy? (Answer for now: use the port-based URL resolution, which already works.)
- [ ] **OpenAPI client generation.** We want typed oRPC-wrapped clients auto-generated from committed specs. What's the toolchain? `@orpc/openapi` can generate specs; can it also consume them to produce clients? Or do we use a separate codegen tool?
- [ ] **Third-party / non-oRPC services.** The abstraction should work for any HTTP service with an OpenAPI spec, not just our TS/oRPC ones. The registration protocol is HTTP-based and contract-agnostic — the oRPC contract is a TS-specific nicety on top.
- [ ] **Package naming convention.** When a contract is shared between services, how do we name things? Options: `widget-contract` for the shape + each service's definition package re-exports it. Or: contracts always live in the definition package (1:1 today).
- [ ] **Migration path from current manifests.** The existing `ordersServiceManifest` etc. evolve into ServiceDefinitions. Incremental: add `start()`, rename `orpcContract` → `contract`, replace `envVars` with `configSchema`.
- [ ] **`defineService()` helper.** Utility function that validates the definition shape and returns a typed object. Handles boilerplate like OTEL init, registry registration, graceful shutdown signal handling.

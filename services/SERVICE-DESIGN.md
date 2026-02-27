# Service Abstraction Design

Living document. Tracks the design of the service abstraction for Iterate deployments.

## What is a service?

A **service** is a named, network-addressable unit of compute that:

- Receives HTTP traffic routed through Caddy
- Is addressable at `{slug}.iterate.localhost` (and all subdomains of that)
- Describes its API via a committed `openapi.json`
- Self-registers with a **registry service** on startup
- Declares a typed **config schema** ("here's what I need to run")
- Is topology-agnostic — can run anywhere with a network path to registry + Caddy

A service's external representation is exactly two things:

1. A hostname you can address
2. An OpenAPI spec describing what HTTP requests it accepts

## ServiceDefinition

The canonical type. A service definition is a **TS package** that exports this shape:

```typescript
interface ServiceDefinition<
  TContract extends AnyContractRouter = AnyContractRouter,
  TConfig extends z.ZodType = z.ZodType,
> {
  /** Unique identifier. Used in hostnames, file paths, registry keys. kebab-case. */
  slug: string;

  /** Semver */
  version: string;

  /** The oRPC contract this service implements (for TS/oRPC services) */
  contract?: TContract;

  /**
   * Typed config schema — what this service needs to run.
   * NOT env vars. The registry provides values for this schema.
   * Think of it as the service's "constructor parameters".
   */
  configSchema: TConfig;

  /** Path to a SQLite DB that should appear in the viewer, if any */
  sqliteDbPath?: string;

  /**
   * Start the service. Receives parsed, validated config.
   * Returns `{ target }` — the address where Caddy should send traffic.
   *
   * The service listens on an OS-assigned ephemeral port (port 0),
   * then reports that port as part of the target.
   *
   * For TS/oRPC services: sets up Hono, mounts handlers, registers with registry, listens.
   * For wrapped non-TS services: spawns the inner process, starts a TS proxy in front of it.
   *
   * Graceful shutdown is handled via POSIX signals (SIGTERM), not a stop() function.
   */
  start(config: z.infer<TConfig>): Promise<ServiceStartResult>;
}

interface ServiceStartResult {
  /** The address Caddy should route traffic to (e.g. "127.0.0.1:54321") */
  target: string;
}
```

### Why `{ target }` and not `stop()`?

Shutdown is handled via POSIX signals, not an explicit `stop()` function:

- **SIGTERM is how processes die in production.** Pidnap, Docker, systemd all send SIGTERM. No custom API needed.
- **Composes naturally.** The TS wrapper catches SIGTERM, kills child processes, cleans up, exits.
- **Works for non-TS services for free.** Every process understands signals.
- **No awkward "who calls stop?"** The service IS the process. The OS manages its lifecycle.

A service's `start()` function should set up signal handlers as part of its initialization:

```typescript
async start(config) {
  const db = createDb(config.dbPath);
  const app = new Hono();
  // mount handlers...
  const server = createServer(nodeHandler(app));
  const port = await listen(server, 0);

  // Graceful shutdown via signals
  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await registerWithRegistry(this, port);
  return { target: `127.0.0.1:${port}` };
}
```

### Why ephemeral ports?

Services do NOT have hardcoded ports. They request port 0 from the OS and get whatever's available. The actual port is reported to the registry as part of the `target`.

This is essential because:

- **Shared namespace.** In a non-containerized deployment, all services share the same host. Hardcoded ports collide.
- **Topology-agnostic.** The abstraction should work identically whether services are co-located or distributed.
- **Caddy handles addressing.** Callers never use ports directly — they use `{slug}.iterate.localhost` and Caddy routes to the right backend.

A `port` field on the definition can still exist as a **hint/preferred port** for local development convenience, but the system never depends on it being available.

### Why a package with start()?

Every service — even non-TS ones — gets a thin TS definition package. This gives us:

- **Uniform entrypoint.** Pidnap, registry, test harnesses all call `start()`. No separate "how to run this" config.
- **Typed config pipeline.** Config schema is Zod (TS anyway). `start()` receives parsed, validated config.
- **Adapter layer for non-TS services.** The `start()` function can spawn a child process and proxy to it. The wrapper is tiny.

### Every service is a TS program

Even when wrapping third-party software (ClickStack, Outerbase, etc.), the service is always a runnable TS program that conforms to the `ServiceDefinition` interface. The TS wrapper:

1. Starts the inner process on an ephemeral port
2. Starts its own HTTP server (also ephemeral port) that proxies to the inner process
3. Can serve its own endpoints (`/openapi.json`, `/orpc/*`, health checks) alongside the proxy
4. Reports its own port as the `target` to the registry

From Caddy's perspective, every service looks the same: one slug, one hostname, one backend. Internal routing (sub-services, admin panels, etc.) is the service's own business.

```typescript
// Example: wrapping a non-TS service
export default defineService({
  slug: "outerbase",
  configSchema: z.object({ dbUrl: z.string() }),
  async start(config) {
    // 1. Start the inner process
    const proc = spawn("outerbase-server", {
      env: { DATABASE_URL: config.dbUrl, PORT: "0" },
    });
    const innerPort = await waitForPort(proc);

    // 2. Create a proxy app in front of it
    const app = new Hono();
    app.get("/openapi.json", (c) => c.json(spec));
    app.all("/*", proxyTo(innerPort));

    const server = createServer(nodeHandler(app));
    attachWsProxy(server, innerPort);  // WebSocket passthrough
    const port = await listen(server, 0);

    // 3. Signal handling
    const shutdown = async () => {
      server.close();
      proc.kill("SIGTERM");
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return { target: `127.0.0.1:${port}` };
  },
});

// Example: native TS/oRPC service (no proxy needed)
export default defineService({
  slug: "orders",
  contract: ordersContract,
  configSchema: z.object({
    dbPath: z.string(),
    eventsServiceUrl: z.string(),
  }),
  async start(config) {
    const db = createDb(config.dbPath);
    const app = new Hono();
    // mount oRPC handlers, openapi.json, etc.

    const server = createServer(nodeHandler(app));
    const port = await listen(server, 0);

    process.on("SIGTERM", () => { server.close(); process.exit(0); });
    process.on("SIGINT", () => { server.close(); process.exit(0); });

    await registerWithRegistry({ slug: "orders", target: `127.0.0.1:${port}` });
    return { target: `127.0.0.1:${port}` };
  },
});
```

## Proxying non-TS services (Node.js)

When wrapping a non-TS service, the TS wrapper proxies HTTP and WebSocket traffic.

### HTTP proxy (via Hono + node:http)

```typescript
import { createServer, request as httpRequest } from "node:http";
import { Readable } from "node:stream";

function proxyTo(innerPort: number) {
  return async (c: Context) => {
    const url = new URL(c.req.url);
    const proxyRes = await new Promise<IncomingMessage>((resolve, reject) => {
      const proxyReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: innerPort,
          path: url.pathname + url.search,
          method: c.req.method,
          headers: {
            ...Object.fromEntries(c.req.raw.headers),
            host: `127.0.0.1:${innerPort}`,
          },
        },
        resolve,
      );
      proxyReq.on("error", reject);
      if (c.req.raw.body) {
        Readable.fromWeb(c.req.raw.body as any).pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    return new Response(
      proxyRes.statusCode === 204 || proxyRes.statusCode === 304
        ? null
        : (Readable.toWeb(proxyRes) as ReadableStream),
      {
        status: proxyRes.statusCode,
        headers: proxyRes.headers as Record<string, string>,
      },
    );
  };
}
```

### WebSocket proxy (via node:net)

The raw `upgrade` event on the HTTP server handles WebSocket passthrough at the TCP level — no WS library needed:

```typescript
import { connect } from "node:net";

function attachWsProxy(server: import("node:http").Server, innerPort: number) {
  server.on("upgrade", (req, socket, head) => {
    const proxySocket = connect(innerPort, "127.0.0.1", () => {
      const path = req.url || "/";
      const headerLines = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      proxySocket.write(
        `GET ${path} HTTP/1.1\r\n${headerLines}\r\nHost: 127.0.0.1:${innerPort}\r\n\r\n`,
      );
      proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });
}
```

The `upgrade` event fires before Hono sees the request, so Hono handles HTTP and the raw server handles WebSocket upgrades independently.

## Routing model

From the registry + Caddy perspective, a service is always: **one slug, one hostname, one backend.**

- Caddy routes `{slug}.iterate.localhost` and `*.{slug}.iterate.localhost` to the service's `target`
- The registry is a flat `hostname -> target` map
- Internal sub-routing (admin panels, sub-services) is the service's own business

This keeps the registry dead simple and pushes routing complexity to where it belongs — inside the service.

## Contract vs ServiceDefinition

A **contract** is a pure API shape — it carries no identity. A **ServiceDefinition** binds a contract to an identity (slug, config, start logic).

- Two services CAN implement the same contract with different slugs
- A caller depends on the **contract** (for types) and the **slug** (for addressing)
- The contract is "what can I do?", the definition is "who am I, what do I need, and how do I start?"

### ServiceRef (for callers)

What a caller needs to create a client:

```typescript
interface ServiceRef<TContract extends AnyContractRouter> {
  slug: string;
  contract: TContract;
}
```

A ServiceDefinition naturally satisfies ServiceRef.

### Same contract, different services

```typescript
// widget-contract package exports the contract shape
export const widgetContract = oc.router({ ... });

// service-a definition
export const serviceA = defineService({
  slug: "service-a",
  contract: widgetContract,
  // ...
});

// service-b definition — same shape, different identity
export const serviceB = defineService({
  slug: "service-b",
  contract: widgetContract,
  // ...
});
```

## Registration protocol

On startup, `start()` calls the registry:

1. Knows exactly one thing: the registry base URL (env var: `REGISTRY_URL`)
2. Sends a `register` request:
   ```typescript
   {
     slug: string;
     version: string;
     target: string;          // where Caddy can reach me (e.g. "127.0.0.1:54321")
     configSchema?: object;   // JSON Schema of what I need
     openapiSpec?: object;    // the full openapi.json (or URL to fetch it)
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
4. Service applies config and starts accepting traffic

On SIGTERM, the service deregisters before exiting.

## Lifecycle

```
[start(config)]
  -> bind to port 0, get ephemeral port
  -> POST /register { slug, version, target: "127.0.0.1:<port>", ... }
  <- { config, caddy: { configured: true } }
  -> mount handlers, start accepting traffic
  -> return { target }
  ...running...
  [SIGTERM received]
  -> stop accepting traffic
  -> POST /deregister { slug }
  -> close server, cleanup resources
  -> process.exit(0)
```

## Committed openapi.json

Design goal: `openapi.json` files are committed in the repo, not just generated at runtime.

Approach:

- Each service definition package has a script: `pnpm generate:openapi`
- This script imports the contract, uses `@orpc/openapi` to generate the spec, writes to `services/{slug}/openapi.json`
- CI verifies specs are up-to-date (generate + diff)
- Other services/tools can import the committed spec for codegen, docs, etc.

## `defineService()` helper

Utility function that handles boilerplate. A service author writes the minimum; `defineService()` wires up:

- OTEL initialization
- SIGTERM/SIGINT signal handlers with graceful shutdown
- Registry registration + deregistration
- Health check endpoint
- OpenAPI spec serving

```typescript
export function defineService<TContract, TConfig extends z.ZodType>(
  def: ServiceDefinitionInput<TContract, TConfig>,
): ServiceDefinition<TContract, TConfig> {
  return {
    ...def,
    async start(config) {
      initializeServiceOtel(def.slug);

      // Call the user's start logic
      const result = await def.start(config);

      // Wire up signal handlers if not already done
      const shutdown = async () => {
        await deregisterFromRegistry(def.slug);
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);

      // Register with registry
      await registerWithRegistry({
        slug: def.slug,
        target: result.target,
        version: def.version,
      });

      return result;
    },
  };
}
```

## Open questions / future work

- [ ] **Auth between service <-> registry.** Bearer token? mTLS? For now, same-machine trust is fine.
- [ ] **Config distribution details.** Does the registry push config updates, or does the service poll?
- [ ] **OpenAPI client generation.** Typed oRPC-wrapped clients auto-generated from committed specs. Toolchain TBD.
- [ ] **Package naming convention.** When a contract is shared between services, how do we name things?
- [ ] **Migration path from current manifests.** Existing `ordersServiceManifest` etc. evolve into ServiceDefinitions incrementally.
- [ ] **Proxy performance.** The TS proxy layer for wrapped services adds a hop. Probably negligible at our scale but worth benchmarking for high-throughput services.
- [ ] **Health checks.** Should the wrapper proxy health to the inner service, or own it? Leaning toward: wrapper owns it (it knows whether the inner process is alive).

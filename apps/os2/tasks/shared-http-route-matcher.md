---
state: todo
priority: high
size: large
dependsOn: []
---

# Shared HTTP Route Matcher

Create a shared HTTP request matching package so Project Ingress routing and
Project Egress secret/policy routing cannot diverge.

The intended package path is:

```text
packages/shared/src/http-route-matcher
```

There is no package at this path yet. OS2 currently has a local exact-host
ingress matcher under `apps/os2/src/ingress/`; Project Egress has not yet
implemented policy matching. This task exists to collapse both into one shared
problem space before egress grows its own ad hoc matcher.

## Goal

Provide one shared model for:

- matching inbound HTTP requests to Project Ingress fetch callables
- matching Project-local ingress requests to fetch callables
- matching outbound Project Egress requests to policy/secret pipeline stages
- storing simple match rules in D1/SQLite efficiently
- growing toward richer host/path/method/header/body-aware matching without
  changing the domain model

Ingress and egress should differ only in the rule target type. The request match
shape must be the same.

## Core Shape

The shared matcher should be generic over the rule target:

```ts
type HttpRouteRule<TTarget> = {
  id: string;
  priority: number;
  scope?: Record<string, string | null>;
  notes: string | null;
  match: HttpRequestMatch;
  target: TTarget;
  createdAt: string;
  updatedAt: string;
};
```

Possible v1 match shape:

```ts
type HttpRequestMatch = {
  type: "exact-host";
  host: string;
};
```

Future match variants should be additive:

```ts
type HttpRequestMatch =
  | { type: "exact-host"; host: string }
  | { type: "host-path-prefix"; host: string; pathPrefix: string }
  | { type: "method-host-path-prefix"; method: string; host: string; pathPrefix: string }
  | { type: "header"; ... };
```

Do not bake "project hostname lookup" or "secret lookup" into the matcher. The
matcher only evaluates HTTP request properties and returns a rule with a target.

## Target Types

Ingress target examples:

```ts
type IngressTarget = {
  type: "fetch-callable";
  callable: FetchCallable;
};
```

Egress target examples:

```ts
type EgressTarget =
  | {
      type: "egress-policy";
      decision: "allow" | "deny" | "human_approval";
    }
  | {
      type: "secret-pipeline-stage";
      secretLocator: unknown;
    };
```

The exact egress target model is not settled, but it must use the same
`HttpRequestMatch` structure.

## Efficient Storage

The package should include storage helpers or schema guidance for SQL-friendly
tables. The storage model should be efficient for v1 exact-host lookups while
remaining compatible with richer matches later.

Recommended stored columns:

```sql
id TEXT PRIMARY KEY,
scope_kind TEXT,
scope_id TEXT,
priority INTEGER NOT NULL,
notes TEXT,
match_type TEXT NOT NULL,
host TEXT,
path_prefix TEXT,
method TEXT,
match_json TEXT NOT NULL,
target_json TEXT NOT NULL,
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TEXT NOT NULL
```

Recommended indexes:

```sql
CREATE INDEX http_route_rules_exact_host_idx
  ON http_route_rules(scope_kind, scope_id, match_type, host, priority);

CREATE INDEX http_route_rules_scope_idx
  ON http_route_rules(scope_kind, scope_id);
```

For OS2's current D1 shape, app-specific tables may keep names such as
`ingress_routes`, but the row format and lookup helpers should come from the
shared matcher package.

## API Requirements

The shared package should expose:

```ts
normalizeHttpRouteHost(host: string): string;

matchHttpRequest<TTarget>(input: {
  request: Request;
  lookupRules: (lookup: HttpRouteLookup) =>
    Promise<readonly HttpRouteRule<TTarget>[]> | readonly HttpRouteRule<TTarget>[];
  fallbackRules?: readonly HttpRouteRule<TTarget>[];
}): Promise<HttpRouteMatch<TTarget> | null>;

compileHttpRouteLookup(input: {
  request: Request;
  scope?: Record<string, string>;
}): HttpRouteLookup;

parseHttpRouteRule<TTarget>(input: unknown, targetSchema?: unknown): HttpRouteRule<TTarget>;
```

Exact names can change, but the package must make it easy for storage code to
perform a direct indexed lookup for exact-host v1 rules.

## OS2 Migration Requirements

- Replace `apps/os2/src/ingress/host-routing.ts` matcher logic with the shared
  matcher.
- Keep OS2-specific dispatch in OS2 or shared callable helpers; do not move
  Project concepts into the matcher.
- Update global ingress D1 queries to use the shared row semantics.
- Update Project Durable Object local route lookup to use the same shared rule
  shape.
- Ensure future Project Egress policy/secret matching imports the shared matcher
  rather than creating `apps/os2/src/egress/*` matchers.

## Acceptance Criteria

- There is one shared `HttpRequestMatch` type used by both ingress and egress
  design docs.
- Project Ingress rules target fetch callables through the shared rule wrapper.
- Project Egress rules target egress policy/secret pipeline stages through the
  same shared rule wrapper.
- Exact-host matching compiles to a direct indexed SQL lookup.
- The package tests cover exact-host normalization, priority ordering,
  fallback rules, and future-safe parsing of unknown match variants.

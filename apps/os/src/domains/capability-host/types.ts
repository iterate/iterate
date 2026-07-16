/**
 * Capability-mounting data shapes: the `provideCapability` / `revokeCapability`
 * recipes, the durable event payload they reduce to, and the itx-expression
 * grammar. These are the itx contract for dynamic capabilities and are pinned
 * to their zod schemas in capability-host-processor-contract.ts.
 */

/**
 * Durable expression over the project itx surface. Defined at the itx leaf
 * (`src/itx/expression.ts`) because stream push subscriptions persist the same
 * shape; re-exported here so capability-host modules keep one import root.
 */
import type { ItxExpression } from "../../itx/expression.ts";

export type { ItxExpression } from "../../itx/expression.ts";

/** Dynamic invocation envelope used by flattened live capabilities. */
export type FlattenedCapabilityInvocation = {
  args: unknown[];
  flattenNestedPath?: boolean;
  path: string[];
};

/** Target shape for a live capability that wants to receive flattened paths. */
export type FlattenedCapabilityTarget = {
  invokeCapability(input: FlattenedCapabilityInvocation): unknown;
};

/**
 * Capability recipe accepted by `provideCapability`.
 *
 * `types` is the mount's Capability Type Declaration: TypeScript declaration
 * text describing the mounted value. The FIRST exported type/interface is the
 * mount's own type; later exports are supporting types. Bare references to
 * platform types (`export type Root = Stream;`) and npm type imports
 * (`export type Slack = import("@slack/web-api").WebClient;`) both resolve.
 * Validated at provide time — a declaration that does not compile rejects the
 * mount — and read by `itx.docs` (search/get) and `itx.docs.typecheck`. An
 * itx-expression mount provided WITHOUT types EVALUATES the expression once
 * at provide time to ask the capability's `__describe()` and keeps what it
 * reports (MCP doors generate a declaration from tool schemas; OpenAPI doors
 * journal a one-line `import("openapi:<specUrl>")` reference the typechecker
 * resolves at check time) — pass `types` explicitly when the expression has
 * side effects.
 */
export type ProvideCapabilityInput =
  | {
      capability: unknown;
      flattenNestedPaths?: false;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      capability: FlattenedCapabilityTarget;
      flattenNestedPaths: true;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Event payload stored when a capability is mounted on an itx stream. */
export type CapabilityProvidedPayload =
  | {
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Reduced capability table row: payload plus the providing event offset. */
export type CapabilityRecord = CapabilityProvidedPayload & {
  providedAtOffset: number;
};

/** Revoke command for the current mount at a path or one exact mount offset. */
export type RevokeCapabilityInput = {
  path: string[];
  providedAtOffset?: number;
};

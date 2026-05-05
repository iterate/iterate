/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  type D1ObjectCatalogIndexDefinitions,
  withD1ObjectCatalog,
} from "./mixins/with-d1-object-catalog.ts";
import { withDurableObjectCore } from "./mixins/with-durable-object-core.ts";
import type { DurableObjectCoreProtected } from "./mixins/with-durable-object-core.ts";
import { withKvInspector } from "./mixins/with-kv-inspector.ts";
import { withLifecycleHooks, type LifecycleInit } from "./mixins/with-lifecycle-hooks.ts";
import type { Constructor, DurableObjectClass } from "./mixins/mixin-types.ts";
import { withOuterbase } from "./mixins/with-outerbase.ts";

export type IterateDurableObjectBaseOptions<InitParams extends LifecycleInit, Env> = {
  className: string;
  getDatabase(env: Env): D1Database;
  indexes?: D1ObjectCatalogIndexDefinitions<InitParams>;
};

/**
 * Default Iterate Durable Object stack.
 *
 * This is the standard bottom half for application-owned Durable Objects:
 *
 * - Cloudflare runtime core adapters for local SQLite, KV, alarms, and IDs.
 * - lifecycle initialization hooks and guarded `ensureStarted()`.
 * - D1 object catalog projection for enumerable/debuggable objects.
 * - debug fetch routes for DO-local SQLite (`/__outerbase`) and KV (`/__kv`).
 *
 * Callers can layer domain mixins above this base when they own additional
 * behavior, for example stream processor runners or schedulers.
 */
export function createIterateDurableObjectBase<InitParams extends LifecycleInit, Env>(
  options: IterateDurableObjectBaseOptions<InitParams, Env>,
) {
  return withIterateDurableObjectStack(options)(DurableObject);
}

export function withIterateDurableObjectStack<InitParams extends LifecycleInit, Env>(
  options: IterateDurableObjectBaseOptions<InitParams, Env>,
) {
  return function <TBase extends DurableObjectClass>(Base: TBase) {
    const CatalogBase = withD1ObjectCatalog<InitParams, Env>(options)(
      withLifecycleHooks<InitParams>()(withDurableObjectCore(Base)),
    );
    const CatalogBaseWithCore = CatalogBase as typeof CatalogBase &
      Constructor<DurableObjectCoreProtected>;
    const WithOuterbase = withOuterbase({
      unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
    })(CatalogBaseWithCore) as unknown as typeof CatalogBase;
    const WithKvInspector = withKvInspector({
      unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
    })(
      WithOuterbase as typeof CatalogBase & Constructor<DurableObjectCoreProtected>,
    ) as unknown as typeof CatalogBase;

    return WithKvInspector;
  };
}

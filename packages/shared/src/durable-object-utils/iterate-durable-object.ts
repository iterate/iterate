/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import {
  type D1ObjectCatalogIndexDefinitions,
  withD1ObjectCatalog,
} from "./mixins/with-d1-object-catalog.ts";
import { withDurableObjectCore } from "./mixins/with-durable-object-core.ts";
import type { DurableObjectCoreProtected } from "./mixins/with-durable-object-core.ts";
import { withKvInspector } from "./mixins/with-kv-inspector.ts";
import { withLifecycleHooks, type LifecycleStructuredName } from "./mixins/with-lifecycle-hooks.ts";
import type { Constructor, DurableObjectClass } from "./mixins/mixin-types.ts";
import { withOuterbase } from "./mixins/with-outerbase.ts";

type StructuredNameFromSchema<NameSchema extends z.ZodType<LifecycleStructuredName>> =
  z.infer<NameSchema> & LifecycleStructuredName;

export type IterateDurableObjectBaseOptions<
  NameSchema extends z.ZodType<LifecycleStructuredName>,
  Env,
> = {
  className: string;
  getDatabase(env: Env): D1Database;
  indexes?: D1ObjectCatalogIndexDefinitions<StructuredNameFromSchema<NameSchema>>;
  nameSchema: NameSchema;
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
export function createIterateDurableObjectBase<
  NameSchema extends z.ZodType<LifecycleStructuredName>,
  Env,
>(options: IterateDurableObjectBaseOptions<NameSchema, Env>) {
  return withIterateDurableObjectStack(options)(DurableObject);
}

export function withIterateDurableObjectStack<
  NameSchema extends z.ZodType<LifecycleStructuredName>,
  Env,
>(options: IterateDurableObjectBaseOptions<NameSchema, Env>) {
  return function <TBase extends DurableObjectClass>(Base: TBase) {
    const CatalogBase = withD1ObjectCatalog<StructuredNameFromSchema<NameSchema>, Env>(options)(
      withLifecycleHooks<StructuredNameFromSchema<NameSchema>>({
        nameSchema: options.nameSchema as unknown as z.ZodType<
          StructuredNameFromSchema<NameSchema>
        >,
      })(withDurableObjectCore(Base)),
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

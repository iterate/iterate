import { DurableObject } from "cloudflare:workers";

/** Operator reset without replacing the Worker or its DO namespace. */
export class StorageResetDurableObject<Env> extends DurableObject<Env> {
  protected objectName: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Cloudflare's object inventory contains IDs, not names. Preserve the name
    // so a cold instance reached by ID can initialize before an operator reset.
    this.objectName = ctx.id.name || ctx.storage.kv.get<string>("operator:object-name");
    if (ctx.id.name && !ctx.storage.kv.get("operator:object-name")) {
      ctx.storage.kv.put("operator:object-name", ctx.id.name);
    }
  }

  async resetStorage(): Promise<void> {
    await resetDurableObjectStorage(this.ctx);
  }
}

/** Shared with container hosts, which must stop their container first. */
export async function resetDurableObjectStorage(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.deleteAll();
  await ctx.storage.sync();
  ctx.abort("storage reset completed");
}

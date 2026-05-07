import type { worker } from "../../alchemy.run.ts";
import type { DurableObject } from "cloudflare:workers";

export type CloudflareEnv = typeof worker.Env;

type WorkerMainModule = typeof import("../entry.workerd.ts");

type DurableObjectExportNames<TModule> = {
  [K in keyof TModule]: TModule[K] extends abstract new (...args: any[]) => DurableObject<any, any>
    ? K
    : never;
}[keyof TModule] &
  string;

declare global {
  type Env = CloudflareEnv;

  interface ExecutionContext<Props = unknown> {
    readonly exports: Cloudflare.Exports;
  }

  interface DurableObjectState<Props = unknown> {
    readonly exports: Cloudflare.Exports;
  }

  namespace Cloudflare {
    /**
     * Tell Cloudflare's runtime types that OS2's Worker loopback exports are
     * exactly the exports from `entry.workerd.ts`.
     *
     * First-party docs:
     *
     * - `ctx.exports` is the Workers loopback binding API:
     *   https://developers.cloudflare.com/workers/runtime-apis/context/#exports
     * - Cloudflare recommends generated `GlobalProps` for precise
     *   `ctx.exports` and `ctx.props` typing:
     *   https://developers.cloudflare.com/workers/runtime-apis/context/#typescript-types-for-ctxexports-and-ctxprops
     * - The `enable_ctx_exports` compatibility flag controls the runtime API:
     *   https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports
     *
     * We deliberately do not maintain a parallel list of WorkerEntrypoint or
     * capability classes here. `mainModule` points at the whole Worker entry
     * module, so every top-level export participates in Cloudflare's own
     * `Cloudflare.Exports` mapper.
     *
     * Cloudflare still needs `durableNamespaces` to know which exported Durable
     * Object classes should also be typed as namespace bindings. Wrangler writes
     * that as an explicit string union in generated files. OS2 is configured by
     * Alchemy rather than checked-in Wrangler generated types, so we derive the
     * union from the entry module's exported class types instead of spelling out
     * the same names twice.
     *
     * This is why the shared Durable Object mixin result type must preserve the
     * branded `DurableObject<Env>` constructor. If a mixin publishes a plain
     * member-only constructor like `new (...args) => AddedMembers`, this derived
     * union and Cloudflare's own mapper can no longer prove the final class is a
     * Durable Object. The symptom is a misleading circular-looking
     * `DurableObjectBranded` failure when `mainModule` imports the full Worker.
     */
    interface GlobalProps {
      mainModule: WorkerMainModule;
      durableNamespaces: DurableObjectExportNames<WorkerMainModule>;
    }
  }
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}

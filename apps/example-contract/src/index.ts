import { oc } from "@orpc/contract";
import { iterateMetaRouterContract } from "@iterate-com/shared/apps/iterate-contract";
import { z } from "zod";

/**
 * Shared source of truth for the example app's typed RPC surface.
 *
 * `implement(exampleContract)` in `apps/example/src/api/base.ts` binds the
 * server implementation to this contract, and `os.router({...})` in
 * `apps/example/src/api/router.ts` provides the actual handlers.
 *
 * The `iterate.*` subtree is the shared app-level operator/debug namespace that
 * all apps may expose under `/__iterate/*`, while the rest of this file is the
 * example app's own domain-specific surface.
 */
export const exampleContract = oc.router({
  ...iterateMetaRouterContract,
  ping: oc
    .route({ method: "GET", path: "/ping", summary: "Ping", tags: ["debug"] })
    .input(z.object({}).optional().default({}))
    .output(z.object({ message: z.string(), serverTime: z.string() })),
  pirateSecret: oc
    .route({
      method: "GET",
      path: "/pirate-secret",
      summary: "Reveal the configured pirate secret",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(z.object({ secret: z.string() })),
  test: {
    logDemo: oc
      .route({
        method: "POST",
        path: "/test/log-demo",
        summary: "Emit a multi-step server log demo",
        tags: ["debug", "test"],
      })
      .input(
        z.object({
          label: z.string().trim().min(1).default("frontend-button"),
        }),
      )
      .output(
        z.object({
          ok: z.literal(true),
          label: z.string(),
          requestId: z.string(),
          steps: z.array(z.string()),
        }),
      ),
    serverThrow: oc
      .route({
        method: "POST",
        path: "/test/server-throw",
        summary: "Throw a real server exception for stack trace testing",
        tags: ["debug", "test"],
      })
      .input(
        z.object({
          message: z.string().trim().min(1).default("Example server test exception"),
        }),
      )
      .output(z.never()),
  },
  things: {
    create: oc
      .route({ method: "POST", path: "/things", summary: "Create a thing", tags: ["things"] })
      .input(z.object({ thing: z.string().min(1) }))
      .output(
        z.object({
          id: z.string(),
          thing: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    list: oc
      .route({ method: "GET", path: "/things", summary: "List things", tags: ["things"] })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(
        z.object({
          things: z.array(
            z.object({
              id: z.string(),
              thing: z.string(),
              createdAt: z.string(),
              updatedAt: z.string(),
            }),
          ),
          total: z.number().int().nonnegative(),
        }),
      ),
    find: oc
      .route({ method: "GET", path: "/things/{id}", summary: "Get thing by id", tags: ["things"] })
      .input(z.object({ id: z.string() }))
      .output(
        z.object({
          id: z.string(),
          thing: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    remove: oc
      .route({ method: "DELETE", path: "/things/{id}", summary: "Delete thing", tags: ["things"] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});

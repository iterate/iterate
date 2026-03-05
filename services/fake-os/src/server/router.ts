import { os, ORPCError } from "@orpc/server";
import { db } from "./db/index.ts";
import { deploymentsTable, createDeploymentSchema } from "./db/schema.ts";
import { eq } from "drizzle-orm";
import { z } from "zod";

const base = os.$context<{}>();

export const router = base.router({
  health: base.handler(() => ({ ok: true as const, time: new Date().toISOString() })),

  deployments: base.router({
    list: base.handler(async () => {
      return db.select().from(deploymentsTable).all();
    }),

    get: base.input(z.object({ slug: z.string() })).handler(async ({ input }) => {
      const deployment = db
        .select()
        .from(deploymentsTable)
        .where(eq(deploymentsTable.slug, input.slug))
        .get();
      if (!deployment) {
        throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
      }
      return deployment;
    }),

    create: base.input(createDeploymentSchema).handler(async ({ input }) => {
      return db
        .insert(deploymentsTable)
        .values({ provider: input.provider, slug: input.slug, opts: input.opts })
        .returning()
        .get();
    }),

    delete: base.input(z.object({ slug: z.string() })).handler(async ({ input }) => {
      db.delete(deploymentsTable).where(eq(deploymentsTable.slug, input.slug)).run();
      return { ok: true as const };
    }),
  }),
});

export type Router = typeof router;

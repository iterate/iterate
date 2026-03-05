import { ORPCError, implement } from "@orpc/server";
import { fakeOsContract } from "@iterate-com/fake-os-contract";
import { db } from "./db/index.ts";
import * as schema from "./db/schema.ts";
import { eq } from "drizzle-orm";

const os = implement(fakeOsContract).$context<{}>();

export const router = os.router({
  service: {
    health: os.service.health.handler(async () => ({
      ok: true as const,
      service: "fake-os",
      version: "0.0.1",
    })),
    sql: os.service.sql.handler(async () => {
      throw new ORPCError("NOT_IMPLEMENTED", { message: "sql not supported" });
    }),
    debug: os.service.debug.handler(async () => ({
      pid: process.pid,
      ppid: process.ppid,
      uptimeSec: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: "",
      cwd: process.cwd(),
      execPath: process.execPath,
      argv: process.argv,
      env: {},
      memoryUsage: process.memoryUsage(),
    })),
  },

  deployments: {
    list: os.deployments.list.handler(async () => {
      return db.select().from(schema.deploymentsTable).all();
    }),

    get: os.deployments.get.handler(async ({ input }) => {
      const deployment = db
        .select()
        .from(schema.deploymentsTable)
        .where(eq(schema.deploymentsTable.slug, input.slug))
        .get();
      if (!deployment) {
        throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
      }
      return deployment;
    }),

    create: os.deployments.create.handler(async ({ input }) => {
      return db
        .insert(schema.deploymentsTable)
        .values({ provider: input.provider, slug: input.slug, opts: input.opts })
        .returning()
        .get();
    }),

    delete: os.deployments.delete.handler(async ({ input }) => {
      db.delete(schema.deploymentsTable).where(eq(schema.deploymentsTable.slug, input.slug)).run();
      return { ok: true as const };
    }),
  },
});

export type Router = typeof router;

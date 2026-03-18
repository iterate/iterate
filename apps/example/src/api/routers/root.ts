import { desc, eq, sql } from "drizzle-orm";
import { ORPCError, implement } from "@orpc/server";
import { exampleContract } from "@iterate-com/example-contract";
import type { ExampleInitialOrpcContext } from "../context.ts";
import { thingsTable } from "../db/schema.ts";

const os = implement(exampleContract).$context<ExampleInitialOrpcContext>();

const rootRouter = os.router({
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true as const,
      service: context.manifest.slug,
      version: context.manifest.version,
    })),
    sql: os.service.sql.handler(async () => {
      throw new ORPCError("NOT_IMPLEMENTED", { message: "sql not implemented in example" });
    }),
    debug: os.service.debug.handler(async () => {
      if (typeof process === "undefined") {
        return {
          pid: -1,
          ppid: -1,
          uptimeSec: 0,
          nodeVersion: "worker",
          platform: "cloudflare-worker",
          arch: "unknown",
          hostname: "worker",
          cwd: "worker",
          execPath: "worker",
          argv: [],
          env: {},
          memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
        };
      }
      const env: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(process.env)) {
        env[key] = value ?? null;
      }
      const mem = process.memoryUsage();
      return {
        pid: process.pid,
        ppid: process.ppid,
        uptimeSec: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        hostname: "node",
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv,
        env,
        memoryUsage: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
        },
      };
    }),
  },
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
  pirateSecret: os.pirateSecret.handler(async ({ context }) => ({
    secret: context.env.PIRATE_SECRET,
  })),
  things: {
    create: os.things.create.handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await context.db.insert(thingsTable).values({
        id,
        thing: input.thing,
        createdAt: now,
        updatedAt: now,
      });
      return { id, thing: input.thing, createdAt: now, updatedAt: now };
    }),
    list: os.things.list.handler(async ({ context, input }) => {
      const [totalRow] = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(thingsTable);
      const rows = await context.db
        .select()
        .from(thingsTable)
        .orderBy(desc(thingsTable.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { things: rows, total: totalRow?.value ?? 0 };
    }),
    find: os.things.find.handler(async ({ context, input }) => {
      const [row] = await context.db
        .select()
        .from(thingsTable)
        .where(eq(thingsTable.id, input.id))
        .limit(1);
      if (!row) throw new ORPCError("NOT_FOUND", { message: `Thing ${input.id} not found` });
      return row;
    }),
    remove: os.things.remove.handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(thingsTable)
        .where(eq(thingsTable.id, input.id))
        .limit(1);
      if (!existing) return { ok: true as const, id: input.id, deleted: false };
      await context.db.delete(thingsTable).where(eq(thingsTable.id, input.id));
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
});

export default rootRouter;

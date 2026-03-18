import { ORPCError } from "@orpc/server";
import manifest from "../manifest.ts";
import { testRouter } from "./routers/test.ts";
import { thingsRouter } from "./routers/things.ts";
import { os } from "./base.ts";

function createIterateDebugOutput() {
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
      memoryUsage: {
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
      },
    };
  }

  const env: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(process.env)) {
    env[key] = value ?? null;
  }

  const memoryUsage = process.memoryUsage();

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
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
    },
  };
}

export const router = os.router({
  ...testRouter,
  ...thingsRouter,
  iterate: {
    health: os.iterate.health.handler(async () => ({
      ok: true as const,
      app: manifest.slug,
      version: manifest.version,
    })),
    debug: os.iterate.debug.handler(async () => createIterateDebugOutput()),
    execSql: os.iterate.execSql.handler(async () => {
      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "iterate.execSql is not available for this app",
      });
    }),
  },
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
  pirateSecret: os.pirateSecret.handler(async ({ context }) => ({
    secret: context.env.PIRATE_SECRET,
  })),
});

export type Router = typeof router;

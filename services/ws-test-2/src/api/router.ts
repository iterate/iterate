import { hostname } from "node:os";
import { ORPCError, implement } from "@orpc/server";
import { wsTest2Contract, wsTest2ServiceManifest } from "@iterate-com/ws-test-2-contract";
import type { WsTest2Context } from "./context.ts";
const os = implement(wsTest2Contract).$context<WsTest2Context>();

export const router = os.router({
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true as const,
      service: context.serviceName,
      version: wsTest2ServiceManifest.version,
    })),
    sql: os.service.sql.handler(async () => {
      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "sql not supported",
      });
    }),
    debug: os.service.debug.handler(async () => {
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
        hostname: hostname(),
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
    }),
  },
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
});

export type Router = typeof router;

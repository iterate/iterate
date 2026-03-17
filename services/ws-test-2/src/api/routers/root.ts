import { ORPCError, implement } from "@orpc/server";
import { wsTest2Contract, wsTest2ServiceManifest } from "@iterate-com/ws-test-2-contract";
import type { WsTest2Context } from "../context.ts";

function readDebugSnapshot() {
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

const os = implement(wsTest2Contract).$context<WsTest2Context>();

const rootRouter = os.router({
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
    debug: os.service.debug.handler(async () => readDebugSnapshot()),
  },
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
});

export default rootRouter;

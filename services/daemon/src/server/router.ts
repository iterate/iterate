import { hostname } from "node:os";
import { exec } from "tinyexec";
import { daemonContract, daemonServiceManifest } from "@iterate-com/daemon-contract";
import { ORPCError, implement } from "@orpc/server";

const os = implement(daemonContract).$context<{
  requestId: string;
  serviceName: string;
  log: {
    info: (...args: unknown[]) => void;
  };
}>();

const serviceHealth = os.service.health.handler(async ({ context }) => ({
  ok: true as const,
  service: context.serviceName,
  version: daemonServiceManifest.version,
}));

const serviceSql = os.service.sql.handler(async () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "sql not supported" });
});

const serviceDebug = os.service.debug.handler(async () => {
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
});

const toolsExec = os.tools.exec.handler(async ({ input, context }) => {
  context.log.info("daemon.tools.exec", {
    cwd: input.cwd ?? process.cwd(),
    timeoutMs: input.timeoutMs,
  });

  const result = await exec("sh", ["-lc", input.command], {
    nodeOptions: {
      cwd: input.cwd ?? process.cwd(),
      timeout: input.timeoutMs,
    },
  });

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
});

export const daemonRouter = os.router({
  service: {
    health: serviceHealth,
    sql: serviceSql,
    debug: serviceDebug,
  },
  tools: {
    exec: toolsExec,
  },
});

export type DaemonRouter = typeof daemonRouter;

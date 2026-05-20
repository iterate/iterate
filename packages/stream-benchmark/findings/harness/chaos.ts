/**
 * Chaos helpers: resolve DO bindings and invoke kill() RPC.
 */

import type { Stream } from "../../src/stream/v0/stream.js";
import type { StreamV1 } from "../../src/stream/v1/stream.js";
import type { StreamProcessor } from "../../src/stream/v1/stream-processor.js";

export type ChaosBinding = "stream" | "stream-v1" | "stream-processor";

type KillableStub =
  | DurableObjectStub<Stream>
  | DurableObjectStub<StreamV1>
  | DurableObjectStub<StreamProcessor>;

export type KillAttempt = {
  at: string;
  binding: ChaosBinding;
  path: string;
  reason: string;
  ok: boolean;
  detail: string;
};

export function resolveBinding(env: Env, binding: ChaosBinding) {
  if (binding === "stream") return env.STREAM;
  if (binding === "stream-v1") return env.STREAM_V1;
  return env.STREAM_PROCESSOR;
}

export function buildChaosPaths(args: { pathPrefix: string; count: number }): string[] {
  const prefix = args.pathPrefix.startsWith("/") ? args.pathPrefix : `/${args.pathPrefix}`;
  return Array.from({ length: args.count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return `${prefix}-${suffix}`;
  });
}

export async function killOne(args: {
  env: Env;
  binding: ChaosBinding;
  path: string;
  reason: string;
}): Promise<KillAttempt> {
  const stub = resolveBinding(args.env, args.binding).getByName(args.path) as KillableStub;
  try {
    await stub.kill({ reason: args.reason });
    return {
      at: new Date().toISOString(),
      binding: args.binding,
      path: args.path,
      reason: args.reason,
      ok: true,
      detail: "kill returned (unexpected)",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      at: new Date().toISOString(),
      binding: args.binding,
      path: args.path,
      reason: args.reason,
      ok: true,
      detail,
    };
  }
}

export async function runChaosLoop(args: {
  env: Env;
  binding: ChaosBinding;
  paths: string[];
  durationMs: number;
  intervalMs: number;
  killsPerTick: number;
  reason: string;
}): Promise<{ attempts: KillAttempt[]; ticks: number }> {
  const attempts: KillAttempt[] = [];
  const startedAt = Date.now();
  let ticks = 0;

  while (Date.now() - startedAt < args.durationMs) {
    ticks += 1;
    for (let i = 0; i < args.killsPerTick; i += 1) {
      const path = args.paths[Math.floor(Math.random() * args.paths.length)];
      attempts.push(
        await killOne({
          env: args.env,
          binding: args.binding,
          path,
          reason: args.reason,
        }),
      );
    }
    await sleep(args.intervalMs);
  }

  return { attempts, ticks };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

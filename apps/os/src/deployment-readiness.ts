import { isDurableObjectLifecycleError } from "./domains/streams/stream-unavailable.ts";

const workerVersionHeader = "x-iterate-worker-version";
const deploymentReadinessProbeTimeoutMs = 8_000;

/** Public health-query key used only by the authenticated preview rollout gate. */
export const deploymentReadinessProbeQueryParam = "deployment-probe";
export const deploymentReadinessProbeWaveCount = 10;
const deploymentReadinessProbesPerWave = 8;

/** Fixed wave-scoped identities for every project-shaped namespace except CapabilityHost. */
export const deploymentReadinessProjectProbes = [
  ["AGENT", "/agents/deployment-readiness"],
  ["AGENT_COLLECTION", "/agents"],
  ["DEVICE", "/devices/deployment-readiness"],
  ["PROJECT", "/"],
  ["REPO", "/repos/deployment-readiness"],
  ["SCHEDULER", "/scheduler/deployment-readiness"],
  ["SECRET", "/secrets/deployment-readiness"],
  ["WORKER", "/workers/deployment-readiness"],
  ["WORKSPACE_V2", "/workspaces/deployment-readiness"],
  ["SANDBOX_LITE", "/sandboxes/deployment-readiness"],
  ["SANDBOX_BASIC", "/sandboxes/deployment-readiness"],
  ["SANDBOX_STANDARD_1", "/sandboxes/deployment-readiness"],
  ["SANDBOX_STANDARD_2", "/sandboxes/deployment-readiness"],
  ["SANDBOX_STANDARD_3", "/sandboxes/deployment-readiness"],
  ["SANDBOX_STANDARD_4", "/sandboxes/deployment-readiness"],
] as const;

/** Parse one canonical wave; malformed or out-of-range values are not aliases. */
export function deploymentReadinessProbeWave(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const wave = Number(value);
  return Number.isSafeInteger(wave) && wave < deploymentReadinessProbeWaveCount ? wave : null;
}

/** Eight distinct placements in each of ten bounded waves. */
export function deploymentReadinessProbeIndexes(wave: number): number[] {
  if (!Number.isSafeInteger(wave) || wave < 0 || wave >= deploymentReadinessProbeWaveCount) {
    throw new Error(`Deployment readiness wave must be from 0 to 9; received ${wave}.`);
  }
  const first = wave * deploymentReadinessProbesPerWave;
  return Array.from({ length: deploymentReadinessProbesPerWave }, (_, index) => first + index);
}

export function deploymentReadinessRequestAuthorized(
  request: Request,
  expectedBearerToken: string | undefined,
): boolean {
  if (!expectedBearerToken) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return timingSafeStringEqual(authorization.slice("Bearer ".length), expectedBearerToken);
}

type DeploymentReadinessProbe = {
  name: string;
  readVersion(): PromiseLike<string>;
};

/** Report ready only when every named probe serves the exact edge version. */
export async function deploymentReadinessResponse(input: {
  app: string;
  probes: readonly DeploymentReadinessProbe[];
  version: string;
  wave: number;
}): Promise<Response> {
  const settled = await settleReadinessProbes(input.probes);
  if (settled === null) {
    console.warn("Durable Object deployment readiness probes timed out", {
      app: input.app,
      probeCount: input.probes.length,
      wave: input.wave,
    });
    return readinessResponse(input, [], "probe-timeout", false);
  }

  const observations = settled.map((result, index) => {
    const probe = input.probes[index]!;
    if (result.status === "fulfilled") return { name: probe.name, version: result.value };
    if (!isDurableObjectLifecycleError(result.reason)) throw result.reason;
    console.info("Durable Object deployment readiness is still settling", {
      app: input.app,
      probe: probe.name,
      reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      wave: input.wave,
    });
    return { name: probe.name, version: null };
  });
  const ready =
    observations.length > 0 &&
    observations.every((observation) => observation.version === input.version);
  const settlingReason = observations.some((observation) => observation.version === null)
    ? "durable-object-lifecycle"
    : ready
      ? null
      : "version-mismatch";
  return readinessResponse(input, observations, settlingReason, ready);
}

async function settleReadinessProbes(probes: readonly DeploymentReadinessProbe[]) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(probes.map((probe) => probe.readVersion())),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), deploymentReadinessProbeTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function readinessResponse(
  input: { app: string; version: string; wave: number },
  durableObjectProbes: readonly { name: string; version: string | null }[],
  settlingReason: "durable-object-lifecycle" | "probe-timeout" | "version-mismatch" | null,
  ready: boolean,
) {
  return Response.json(
    {
      ok: ready,
      app: input.app,
      version: input.version,
      deploymentProbeWave: input.wave,
      deploymentProbeWaveCount: deploymentReadinessProbeWaveCount,
      durableObjectProbes,
      durableObjectProbeCount: durableObjectProbes.length,
      ...(settlingReason === null ? {} : { settlingReason }),
      ...(ready ? {} : { expectedDurableObjectVersion: input.version }),
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "cache-control": "no-store",
        [workerVersionHeader]: input.version,
      },
    },
  );
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

const workerVersionHeader = "x-iterate-worker-version";

/** Public health-query key used only by the bounded preview rollout gate. */
export const deploymentReadinessProbeQueryParam = "deployment-probe";
export const deploymentReadinessProbeWaveCount = 10;
const deploymentReadinessProbesPerWave = 8;

/** Map an untrusted query value onto the finite readiness-probe set. */
export function deploymentReadinessProbeWave(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence % deploymentReadinessProbeWaveCount : 0;
}

/** Eight distinct placements in each of ten bounded waves. */
export function deploymentReadinessProbeIndexes(wave: number): number[] {
  const normalizedWave =
    Number.isSafeInteger(wave) && wave >= 0 ? wave % deploymentReadinessProbeWaveCount : 0;
  const first = normalizedWave * deploymentReadinessProbesPerWave;
  return Array.from({ length: deploymentReadinessProbesPerWave }, (_, index) => first + index);
}

/**
 * Turn an exact-version Durable Object sample into a readiness response.
 * A rejected RPC is an explicit 503 settling state: the caller retries this
 * bounded gate while an incarnation is being reset by workerd.
 */
export async function deploymentReadinessResponse(input: {
  app: string;
  readDurableObjectVersions(): Promise<readonly string[]>;
  version: string;
}): Promise<Response> {
  let durableObjectVersions: readonly string[] | null = null;
  let settlingReason: string | null = null;
  try {
    durableObjectVersions = await input.readDurableObjectVersions();
  } catch (error) {
    settlingReason = error instanceof Error ? error.message : String(error);
    console.info("Durable Object deployment readiness is still settling", {
      app: input.app,
      expectedVersion: input.version,
      reason: settlingReason,
    });
  }

  const ready =
    durableObjectVersions !== null &&
    durableObjectVersions.length > 0 &&
    durableObjectVersions.every((version) => version === input.version);

  return Response.json(
    {
      ok: ready,
      app: input.app,
      version: input.version,
      durableObjectVersions,
      durableObjectProbeCount: durableObjectVersions?.length ?? 0,
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

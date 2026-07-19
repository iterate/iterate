import { isDurableObjectLifecycleError } from "~/domains/streams/stream-unavailable.ts";

const workerVersionHeader = "x-iterate-worker-version";

/**
 * Report the edge Worker ready only after every bounded Stream Durable Object
 * probe runs the same deployment. A code-update reset is an expected settling
 * signal here: it stays a visible 503 until the next probe succeeds, before
 * e2e traffic is allowed to start.
 */
export async function streamDeploymentReadinessResponse(input: {
  readDurableObjectVersions(): Promise<readonly string[]>;
  version: string;
}): Promise<Response> {
  let durableObjectVersions: readonly string[] | null = null;
  let settlingReason: "durable-object-lifecycle" | null = null;
  try {
    durableObjectVersions = await input.readDurableObjectVersions();
  } catch (error) {
    if (!isDurableObjectLifecycleError(error)) throw error;
    // The readiness status explicitly models this workerd-classified rollout
    // transition. It remains a visible 503 without polluting error telemetry.
    settlingReason = "durable-object-lifecycle";
  }

  const ready =
    durableObjectVersions !== null &&
    durableObjectVersions.length > 0 &&
    durableObjectVersions.every((version) => version === input.version);

  return Response.json(
    {
      ok: ready,
      app: "streams-example-app",
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

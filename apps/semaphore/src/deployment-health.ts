const workerVersionHeader = "x-iterate-worker-version";

/**
 * Prove that a newly routed Semaphore Worker and the coordinator objects it
 * creates have reached the same deployment before preview tests begin.
 */
export async function semaphoreDeploymentHealth(input: {
  workerVersion: string;
  coordinatorVersion: () => Promise<string>;
}): Promise<Response> {
  const headers = {
    "content-type": "application/json",
    [workerVersionHeader]: input.workerVersion,
  };
  let coordinatorVersion: string;
  try {
    coordinatorVersion = await input.coordinatorVersion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        ok: false,
        workerVersion: input.workerVersion,
        error: message.slice(0, 500),
      },
      { status: 503, headers },
    );
  }

  if (coordinatorVersion !== input.workerVersion) {
    return Response.json(
      {
        ok: false,
        workerVersion: input.workerVersion,
        coordinatorVersion,
      },
      { status: 503, headers },
    );
  }

  return Response.json(
    {
      ok: true,
      workerVersion: input.workerVersion,
      coordinatorVersion,
    },
    { status: 200, headers },
  );
}

import type { Deployment } from "@iterate-com/shared/jonasland/deployment";

const DEFAULT_TIMEOUT_MS = 120_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHostHealthViaLoopback(params: {
  deployment: Pick<Deployment, "exec">;
  host: string;
  path?: string;
  timeoutMs?: number;
}): Promise<void> {
  const path = params.path?.startsWith("/") ? params.path : `/${params.path ?? "healthz"}`;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastOutput = "";

  while (Date.now() < deadline) {
    const result = await params.deployment
      .exec(["sh", "-ec", `curl -fsS -H 'Host: ${params.host}' 'http://127.0.0.1${path}'`])
      .catch((error) => ({
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
      }));

    if (result.exitCode === 0) {
      return;
    }

    lastOutput = result.output;
    await sleep(250);
  }

  throw new Error(
    `timed out waiting for ${params.host}${path} via loopback\n${lastOutput.slice(0, 1000)}`,
  );
}

export async function waitForBuiltInServicesOnline(params: {
  deployment: Pick<
    Deployment,
    "waitForPidnapProcessRunning" | "waitForPidnapHostRoute" | "waitForCaddyHealthy" | "exec"
  >;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await params.deployment.waitForCaddyHealthy({ timeoutMs });
  await params.deployment.waitForPidnapHostRoute({ timeoutMs });

  for (const processSlug of ["caddy", "registry", "events"] as const) {
    await params.deployment.waitForPidnapProcessRunning({
      target: processSlug,
      timeoutMs,
    });
  }

  await waitForHostHealthViaLoopback({
    deployment: params.deployment,
    host: "registry.iterate.localhost",
    path: "/orpc/__iterate/health",
    timeoutMs,
  });
  await waitForHostHealthViaLoopback({
    deployment: params.deployment,
    host: "events.iterate.localhost",
    path: "/api/__iterate/health",
    timeoutMs,
  });
}

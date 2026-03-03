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
    path: "/healthz",
    timeoutMs,
  });
  await waitForHostHealthViaLoopback({
    deployment: params.deployment,
    host: "events.iterate.localhost",
    path: "/healthz",
    timeoutMs,
  });
}

export async function startOnDemandServiceViaPidnap(params: {
  deployment: Pick<Deployment, "pidnap" | "waitForPidnapProcessRunning" | "exec">;
  processSlug: string;
  definition: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  healthHost?: string;
  healthPath?: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const updateResult = await params.deployment.pidnap.processes.updateConfig({
    processSlug: params.processSlug,
    definition: {
      command: params.definition.command,
      args: params.definition.args,
      ...(params.definition.env ? { env: params.definition.env } : {}),
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
    restartImmediately: true,
  });

  if (updateResult.state !== "running") {
    await params.deployment.pidnap.processes.start({
      target: params.processSlug,
    });
  }

  await params.deployment.waitForPidnapProcessRunning({
    target: params.processSlug,
    timeoutMs,
  });

  if (params.healthHost) {
    await waitForHostHealthViaLoopback({
      deployment: params.deployment,
      host: params.healthHost,
      path: params.healthPath,
      timeoutMs,
    });
  }
}

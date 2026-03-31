import { makeFunnySlug } from "@iterate-com/shared/slug-maker";
import {
  Deployment,
  createDeploymentSlug,
} from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  createDockerProvider,
  dockerDeploymentLocatorSchema,
  dockerProviderOptsSchema,
  dockerDeploymentOptsSchema,
  type DockerDeploymentLocator,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import {
  createFlyProvider,
  flyDeploymentLocatorSchema,
  flyProviderOptsSchema,
  flyDeploymentOptsSchema,
  type FlyDeploymentLocator,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { os } from "@orpc/server";
import { z } from "zod/v4";
import { jsonInput } from "../../packages/shared/src/zod-helpers.ts";

const jsonRecordInput = jsonInput.pipe(z.record(z.string(), z.unknown()));

export const deploymentRouter = os.router({
  create: os
    .input(
      z.object({
        provider: z.enum(["docker", "fly"]).default("docker"),
        slug: z.string().min(1).optional(),
        image: z.string().min(1).optional(),
        rootfsSurvivesRestart: z.coerce.boolean().optional(),
        env: jsonRecordInput.optional(),
        flyOrgSlug: z.string().min(1).optional(),
        flyNetwork: z.string().min(1).optional(),
        flyRegion: z.string().min(1).optional(),
        flyMachineCpus: z.coerce.number().int().positive().optional(),
        flyMachineMemoryMb: z.coerce.number().int().positive().optional(),
        flyMachineName: z.string().min(1).optional(),
      }),
    )
    .meta({
      description: "Create a deployment and wait healthy",
      default: true,
      prompt: false,
    })
    .handler(async ({ input, signal }) => {
      let deployment: Deployment;
      if (input.provider === "docker") {
        deployment = await Deployment.create({
          provider: createProviderForKind("docker"),
          opts: dockerDeploymentOptsSchema.parse({
            slug: input.slug ?? createDefaultCliDeploymentSlug(),
            image: input.image ?? resolveDefaultSandboxImage(),
            rootfsSurvivesRestart: input.rootfsSurvivesRestart,
            env: {
              ...(input.env ?? {}),
              DOCKER_HOST_SYNC_ENABLED:
                typeof input.env?.DOCKER_HOST_SYNC_ENABLED === "string"
                  ? input.env.DOCKER_HOST_SYNC_ENABLED
                  : "true",
            },
          }),
          signal,
          onLogEntry: writeDeploymentLogEntryToStdout,
        });
      } else {
        deployment = await Deployment.create({
          provider: createProviderForKind("fly"),
          opts: flyDeploymentOptsSchema.parse({
            slug: input.slug ?? createDefaultCliDeploymentSlug(),
            image: input.image ?? resolveDefaultSandboxImage(),
            rootfsSurvivesRestart: input.rootfsSurvivesRestart,
            env: input.env,
            flyOrgSlug: input.flyOrgSlug,
            flyNetwork: input.flyNetwork,
            flyRegion: input.flyRegion,
            flyMachineCpus: input.flyMachineCpus,
            flyMachineMemoryMb: input.flyMachineMemoryMb,
            flyMachineName: input.flyMachineName,
          }),
          signal,
          onLogEntry: writeDeploymentLogEntryToStdout,
        });
      }

      await streamLogsWhileWaitingHealthy({
        deployment,
        signal,
      });
      return summarizeCreatedDeployment({
        provider: input.provider,
        deployment,
      });
    }),
  destroy: os
    .input(
      z.object({
        locator: jsonInput.pipe(
          z.discriminatedUnion("provider", [
            dockerDeploymentLocatorSchema,
            flyDeploymentLocatorSchema,
          ]),
        ),
      }),
    )
    .meta({
      description: "Destroy a deployment by locator",
    })
    .handler(async ({ input, signal }) => {
      const deployment = await connectDeploymentFromLocator({
        locator: input.locator,
        signal,
      });
      const summary = summarizeCreatedDeployment({
        provider: input.locator.provider,
        deployment,
      });
      await deployment.destroy();
      return summary;
    }),
  logs: os
    .input(
      z.object({
        locator: jsonInput.pipe(
          z.discriminatedUnion("provider", [
            dockerDeploymentLocatorSchema,
            flyDeploymentLocatorSchema,
          ]),
        ),
      }),
    )
    .meta({
      description: "Stream deployment logs until interrupted",
    })
    .handler(async ({ input, signal }) => {
      const deployment = await connectDeploymentFromLocator({
        locator: input.locator,
        signal,
      });
      for await (const entry of deployment.logs({ signal })) {
        writeDeploymentLogEntryToStdout(entry);
      }
    }),
  shell: os
    .input(
      z.object({
        locator: jsonInput.pipe(
          z.discriminatedUnion("provider", [
            dockerDeploymentLocatorSchema,
            flyDeploymentLocatorSchema,
          ]),
        ),
        cmd: z.string().min(1),
      }),
    )
    .meta({
      description: "Run a shell command in deployment",
    })
    .handler(async ({ input, signal }) => {
      const deployment = await connectDeploymentFromLocator({
        locator: input.locator,
        signal,
      });
      return await deployment.shell({
        cmd: input.cmd,
        signal,
      });
    }),
});

function summarizeCreatedDeployment(params: {
  provider: "docker" | "fly";
  deployment: Deployment;
}) {
  return {
    provider: params.provider,
    slug: params.deployment.slug,
    ingressHost: params.deployment.env.ITERATE_INGRESS_HOST,
    ingressUrl: `http://${params.deployment.env.ITERATE_INGRESS_HOST}`,
    locator: params.deployment.locator,
    opts: params.deployment.opts,
  };
}

function createDefaultCliDeploymentSlug() {
  return createDeploymentSlug({
    input: `from-cli-${makeFunnySlug()}`,
  });
}

function createProviderForKind(provider: "docker"): ReturnType<typeof createDockerProvider>;
function createProviderForKind(provider: "fly"): ReturnType<typeof createFlyProvider>;
function createProviderForKind(provider: "docker" | "fly") {
  switch (provider) {
    case "docker":
      return createDockerProvider(dockerProviderOptsSchema.parse({}));
    case "fly":
      return createFlyProvider(
        flyProviderOptsSchema.parse({
          flyApiToken: requireFlyApiToken(),
        }),
      );
  }
}

async function connectDeploymentFromLocator(params: {
  locator: DockerDeploymentLocator | FlyDeploymentLocator;
  signal?: AbortSignal;
}) {
  switch (params.locator.provider) {
    case "docker":
      return await Deployment.connect({
        provider: createProviderForKind("docker"),
        locator: params.locator,
        signal: params.signal,
      });
    case "fly":
      return await Deployment.connect({
        provider: createProviderForKind("fly"),
        locator: params.locator,
        signal: params.signal,
      });
  }
}

async function streamLogsWhileWaitingHealthy(params: {
  deployment: Deployment;
  signal?: AbortSignal;
}) {
  const logsController = new AbortController();
  const stopLogStream = () => {
    if (!logsController.signal.aborted) {
      logsController.abort();
    }
  };

  params.signal?.addEventListener("abort", stopLogStream, { once: true });

  const logsTask = (async () => {
    for await (const entry of params.deployment.logs({
      signal: logsController.signal,
      tail: 0,
    })) {
      writeDeploymentLogEntryToStdout(entry);
    }
  })();

  try {
    await params.deployment.waitUntilHealthy({
      signal: params.signal,
    });
  } finally {
    stopLogStream();
    params.signal?.removeEventListener("abort", stopLogStream);
    await logsTask;
  }
}

function requireFlyApiToken() {
  const flyApiToken = process.env.FLY_API_TOKEN?.trim();
  if (!flyApiToken) {
    throw new Error("FLY_API_TOKEN is required for Fly deployment commands");
  }
  return flyApiToken;
}

function resolveDefaultSandboxImage() {
  return process.env.JONASLAND_SANDBOX_IMAGE?.trim() || "jonasland-sandbox:latest";
}

function writeDeploymentLogEntryToStdout(entry: { text: string }) {
  process.stdout.write(`${entry.text}\n`);
}

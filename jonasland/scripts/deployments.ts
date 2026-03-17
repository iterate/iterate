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
} from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import {
  createFlyProvider,
  flyDeploymentLocatorSchema,
  flyProviderOptsSchema,
  flyDeploymentOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { z } from "zod/v4";
import { scriptCli } from "./_cli.ts";

const jsonInput = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Invalid JSON",
    });
    return z.NEVER;
  }
});

const jsonRecordInput = jsonInput.pipe(z.record(z.string(), z.unknown()));

const deploymentLocatorInput = jsonInput.pipe(
  z.discriminatedUnion("provider", [dockerDeploymentLocatorSchema, flyDeploymentLocatorSchema]),
);

const CreateInput = z.object({
  provider: z.enum(["docker", "fly"]),
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
});

const ConnectInput = z.object({
  locator: deploymentLocatorInput,
});

const ShellInput = ConnectInput.extend({
  cmd: z.string().min(1),
});

type CreateInput = z.infer<typeof CreateInput>;
type ConnectInput = z.infer<typeof ConnectInput>;
type ShellInput = z.infer<typeof ShellInput>;

export const deploymentRouter = scriptCli.router({
  create: scriptCli
    .input(CreateInput)
    .meta({
      description: "Create a deployment and wait healthy",
      default: true,
    })
    .handler(async ({ input, signal }: { input: CreateInput; signal?: AbortSignal }) => {
      let deployment: Deployment;
      if (input.provider === "docker") {
        deployment = await Deployment.create({
          provider: createProviderForKind("docker"),
          opts: createDockerOpts(input),
          signal,
          onLogEntry: writeDeploymentLogEntryToStdout,
        });
      } else {
        deployment = await Deployment.create({
          provider: createProviderForKind("fly"),
          opts: createFlyOpts(input),
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
  destroy: scriptCli
    .input(ConnectInput)
    .meta({
      description: "Destroy a deployment by locator",
    })
    .handler(async ({ input, signal }: { input: ConnectInput; signal?: AbortSignal }) => {
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
  logs: scriptCli
    .input(ConnectInput)
    .meta({
      description: "Stream deployment logs until interrupted",
    })
    .handler(async ({ input, signal }: { input: ConnectInput; signal?: AbortSignal }) => {
      const deployment = await connectDeploymentFromLocator({
        locator: input.locator,
        signal,
      });
      for await (const entry of deployment.logs({ signal })) {
        writeDeploymentLogEntryToStdout(entry);
      }
    }),
  shell: scriptCli
    .input(ShellInput)
    .meta({
      description: "Run a shell command in deployment",
    })
    .handler(async ({ input, signal }: { input: ShellInput; signal?: AbortSignal }) => {
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
    runtimeBaseUrl: `http://${params.deployment.env.ITERATE_INGRESS_HOST}`,
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

function createDockerOpts(input: CreateInput) {
  return dockerDeploymentOptsSchema.parse({
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
  });
}

function createFlyOpts(input: CreateInput) {
  return flyDeploymentOptsSchema.parse({
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
  });
}

async function connectDeploymentFromLocator(params: {
  locator: z.infer<typeof deploymentLocatorInput>;
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

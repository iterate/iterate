import { makeFunnySlug } from "@iterate-com/shared/slug-maker";
import {
  Deployment,
  createDeploymentSlug,
} from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  createDockerProvider,
  dockerProviderOptsSchema,
  dockerDeploymentOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import {
  createFlyProvider,
  flyProviderOptsSchema,
  flyDeploymentOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { scriptCli } from "./_cli.ts";

const DockerCreateInput = dockerDeploymentOptsSchema.partial().optional().default({});
const FlyCreateInput = flyDeploymentOptsSchema.partial().optional().default({});

export const deploymentsRouter = scriptCli.router({
  docker: {
    create: scriptCli
      .input(DockerCreateInput)
      .meta({
        description: "Create a docker deployment with jonasland defaults",
        default: true,
      })
      .handler(async ({ input }) => {
        const opts = dockerDeploymentOptsSchema.parse({
          ...input,
          slug: input.slug ?? createDefaultCliDeploymentSlug(),
          image: input.image ?? "jonasland-sandbox:latest",
          env: {
            ...(input.env ?? {}),
            DOCKER_HOST_SYNC_ENABLED: input.env?.DOCKER_HOST_SYNC_ENABLED ?? "true",
          },
        });
        const deployment = await Deployment.create({
          provider: createDockerProvider(dockerProviderOptsSchema.parse({})),
          opts,
          onLogEntry: writeDeploymentLogEntryToStdout,
        });
        return summarizeCreatedDeployment({
          provider: "docker",
          deployment,
        });
      }),
  },
  fly: {
    create: scriptCli
      .input(FlyCreateInput)
      .meta({
        description: "Create a fly deployment with jonasland defaults",
        default: true,
      })
      .handler(async ({ input }) => {
        const flyApiToken = process.env.FLY_API_TOKEN?.trim();
        if (!flyApiToken) {
          throw new Error("FLY_API_TOKEN is required for `cli deployments fly create`");
        }

        const opts = flyDeploymentOptsSchema.parse({
          ...input,
          slug: input.slug ?? createDefaultCliDeploymentSlug(),
          image: input.image ?? "jonasland-sandbox:latest",
        });
        const deployment = await Deployment.create({
          provider: createFlyProvider(flyProviderOptsSchema.parse({ flyApiToken })),
          opts,
          onLogEntry: writeDeploymentLogEntryToStdout,
        });
        return summarizeCreatedDeployment({
          provider: "fly",
          deployment,
        });
      }),
  },
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

function writeDeploymentLogEntryToStdout(entry: { text: string }) {
  process.stdout.write(`${entry.text}\n`);
}

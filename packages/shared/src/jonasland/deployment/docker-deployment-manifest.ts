import type { DockerClient } from "@docker/node-sdk";
import { z } from "zod/v4";
import type {
  DeploymentOpts,
  DeploymentProviderManifest,
  DeploymentProviderOpts,
} from "./deployment-provider-manifest.ts";
import { BaseDeploymentOpts, DeploymentRuntimeEnv } from "./deployment-provider-manifest.ts";

type DockerSdkClient = Awaited<ReturnType<typeof DockerClient.fromDockerConfig>>;
type DockerCreateBody = Parameters<DockerSdkClient["containerCreate"]>[0];
export type DockerHostConfig = NonNullable<DockerCreateBody["HostConfig"]>;
export const DockerDeploymentRuntimeEnv = DeploymentRuntimeEnv.extend({
  DOCKER_HOST_SYNC_ENABLED: z.enum(["true", "false"]).optional(),
});
export type DockerDeploymentRuntimeEnv = z.infer<typeof DockerDeploymentRuntimeEnv>;

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  containerName?: string;
}

export interface DockerProviderOpts extends DeploymentProviderOpts {}

export interface DockerDeploymentOpts extends DeploymentOpts {
  env?: DockerDeploymentRuntimeEnv;
  dockerHostConfig?: DockerHostConfig;
}

export const DockerProviderOpts = z.object({});
export const DockerDeploymentLocator = z.object({
  provider: z.literal("docker"),
  containerId: z.string().min(1),
  containerName: z.string().min(1).optional(),
});
export const DockerDeploymentOpts = BaseDeploymentOpts.extend({
  env: DockerDeploymentRuntimeEnv.optional(),
  dockerHostConfig: z.custom<DockerHostConfig>().optional(),
});
export {
  DockerDeploymentLocator as dockerDeploymentLocatorSchema,
  DockerDeploymentOpts as dockerDeploymentOptsSchema,
  DockerProviderOpts as dockerProviderOptsSchema,
};

export const dockerProviderManifest = {
  name: "docker",
  providerOptsSchema: DockerProviderOpts,
  optsSchema: DockerDeploymentOpts,
  locatorSchema: DockerDeploymentLocator,
} satisfies DeploymentProviderManifest<
  DockerDeploymentOpts,
  DockerDeploymentLocator,
  DockerProviderOpts
>;

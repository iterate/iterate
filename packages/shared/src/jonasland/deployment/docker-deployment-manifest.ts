import type { DockerClient } from "@docker/node-sdk";
import { z } from "zod/v4";
import type {
  DeploymentOpts,
  DeploymentProviderManifest,
  DeploymentProviderOpts,
} from "./deployment-provider-manifest.ts";

type DockerSdkClient = Awaited<ReturnType<typeof DockerClient.fromDockerConfig>>;
type DockerCreateBody = Parameters<DockerSdkClient["containerCreate"]>[0];
export type DockerHostConfig = NonNullable<DockerCreateBody["HostConfig"]>;

export interface DockerHostSyncConfig {
  repoRoot: string;
  gitDir?: string;
  commonDir?: string;
  repoCheckoutMountPath?: string;
  gitDirMountPath?: string;
  commonDirMountPath?: string;
}

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  containerName?: string;
}

export interface DockerProviderOpts extends DeploymentProviderOpts {}

export interface DockerDeploymentOpts extends DeploymentOpts {
  dockerHostConfig?: DockerHostConfig;
  /**
   * Enable host-repo sync during sandbox boot.
   *
   * This sets `DOCKER_HOST_SYNC_ENABLED=true` inside the container and mounts
   * host checkout paths so the sandbox boot scripts can sync the repo before
   * pidnap starts.
   *
   * - `true`: derive host paths from `DOCKER_HOST_GIT_*` env vars on the caller.
   * - object: use explicit host paths and mount points.
   */
  dockerHostSync?: true | DockerHostSyncConfig;
}

export const DockerProviderOpts = z.object({});
export const DockerDeploymentLocator = z.object({
  provider: z.literal("docker"),
  containerId: z.string().min(1),
  containerName: z.string().min(1).optional(),
});
export const DockerDeploymentOpts = z.object({
  slug: z.string().min(1),
  rootfsSurvivesRestart: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  image: z.string().min(1).optional(),
  entrypoint: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  dockerHostConfig: z.custom<DockerHostConfig>().optional(),
  dockerHostSync: z
    .union([
      z.literal(true),
      z.object({
        repoRoot: z.string(),
        gitDir: z.string().optional(),
        commonDir: z.string().optional(),
        repoCheckoutMountPath: z.string().optional(),
        gitDirMountPath: z.string().optional(),
        commonDirMountPath: z.string().optional(),
      }),
    ])
    .optional(),
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

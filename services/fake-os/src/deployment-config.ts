import { z } from "zod/v4";
import {
  dockerDeploymentOptsSchema,
  dockerProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment-manifest.ts";
import {
  flyDeploymentOptsSchema,
  flyProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment-manifest.ts";

export const DockerDeploymentConfig = z.object({
  providerOpts: dockerProviderOptsSchema.default({}),
  opts: dockerDeploymentOptsSchema.omit({ slug: true }),
});

export const FlyDeploymentConfig = z.object({
  providerOpts: flyProviderOptsSchema,
  opts: flyDeploymentOptsSchema.omit({ slug: true }),
});

export type DockerDeploymentConfig = z.infer<typeof DockerDeploymentConfig>;
export type FlyDeploymentConfig = z.infer<typeof FlyDeploymentConfig>;

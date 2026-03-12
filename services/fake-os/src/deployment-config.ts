import { z } from "zod/v4";
import {
  dockerDeploymentOptsSchema,
  dockerProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment-manifest.ts";
import {
  flyDeploymentOptsSchema,
  flyProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment-manifest.ts";

export const dockerDeploymentConfigSchema = z.object({
  providerOpts: dockerProviderOptsSchema.default({}),
  opts: dockerDeploymentOptsSchema.omit({ slug: true }),
});

export const flyDeploymentConfigSchema = z.object({
  providerOpts: flyProviderOptsSchema,
  opts: flyDeploymentOptsSchema.omit({ slug: true }),
});

export type DockerDeploymentConfig = z.infer<typeof dockerDeploymentConfigSchema>;
export type FlyDeploymentConfig = z.infer<typeof flyDeploymentConfigSchema>;

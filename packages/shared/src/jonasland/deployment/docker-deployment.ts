import type { DeploymentConfigVariant, SerializableObject } from "./deployment.ts";

export type DockerDeploymentConfig<
  TProviderSpecific extends SerializableObject = SerializableObject,
  TShared extends SerializableObject = SerializableObject,
> = DeploymentConfigVariant<"docker", TProviderSpecific, TShared>;

export function defineDockerDeploymentConfig<const T extends DockerDeploymentConfig>(config: T): T {
  return config;
}

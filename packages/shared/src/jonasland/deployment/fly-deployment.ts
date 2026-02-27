import type { DeploymentConfigVariant, SerializableObject } from "./deployment.ts";

export type FlyDeploymentConfig<
  TProviderSpecific extends SerializableObject = SerializableObject,
  TShared extends SerializableObject = SerializableObject,
> = DeploymentConfigVariant<"fly", TProviderSpecific, TShared>;

export function defineFlyDeploymentConfig<const T extends FlyDeploymentConfig>(config: T): T {
  return config;
}

import { z } from "zod/v4";
import type {
  DeploymentOpts,
  DeploymentProviderManifest,
  DeploymentProviderOpts,
} from "./deployment-provider-manifest.ts";
import { BaseDeploymentOpts } from "./deployment-provider-manifest.ts";
import type { components } from "./fly-api/generated/openapi.gen.ts";

export interface FlyDeploymentLocator {
  provider: "fly";
  appName: string;
  machineId?: string;
}

export interface FlyProviderOpts extends DeploymentProviderOpts {
  flyApiToken?: string;
  flyApiBaseUrl?: string;
}

export interface FlyDeploymentOpts extends DeploymentOpts {
  flyMachineInit?: components["schemas"]["fly.MachineInit"];
  flyOrgSlug?: string;
  flyNetwork?: string;
  flyRegion?: string;
  flyMachineCpus?: number;
  flyMachineMemoryMb?: number;
  flyMachineName?: string;
}

export const FlyProviderOpts = z.object({
  flyApiToken: z.string().min(1),
  flyApiBaseUrl: z.string().url().optional(),
});
export const FlyDeploymentLocator = z.object({
  provider: z.literal("fly"),
  appName: z.string().min(1),
  machineId: z.string().min(1).optional(),
});
export const FlyDeploymentOpts = BaseDeploymentOpts.extend({
  flyMachineInit: z.custom<components["schemas"]["fly.MachineInit"]>().optional(),
  flyOrgSlug: z.string().min(1).optional(),
  flyNetwork: z.string().min(1).optional(),
  flyRegion: z.string().min(1).optional(),
  flyMachineCpus: z.number().int().positive().optional(),
  flyMachineMemoryMb: z.number().int().positive().optional(),
  flyMachineName: z.string().min(1).optional(),
});
export {
  FlyDeploymentLocator as flyDeploymentLocatorSchema,
  FlyDeploymentOpts as flyDeploymentOptsSchema,
  FlyProviderOpts as flyProviderOptsSchema,
};

export const flyProviderManifest = {
  name: "fly",
  providerOptsSchema: FlyProviderOpts,
  optsSchema: FlyDeploymentOpts,
  locatorSchema: FlyDeploymentLocator,
} satisfies DeploymentProviderManifest<FlyDeploymentOpts, FlyDeploymentLocator, FlyProviderOpts>;

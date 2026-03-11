import type {
  Deployment,
  DeploymentProvider,
} from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import {
  dockerProviderManifest,
  type DockerDeploymentLocator,
  type DockerDeploymentOpts,
} from "@iterate-com/shared/jonasland/deployment/docker-deployment-manifest.ts";
import {
  flyProviderManifest,
  type FlyDeploymentLocator,
  type FlyDeploymentOpts,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment-manifest.ts";
import { z } from "zod/v4";

export const DockerConfig = z.object({
  providerOpts: dockerProviderManifest.providerOptsSchema.default({}),
  opts: dockerProviderManifest.optsSchema.omit({ slug: true }),
});

export const FlyConfig = z.object({
  providerOpts: flyProviderManifest.providerOptsSchema,
  opts: flyProviderManifest.optsSchema.omit({ slug: true }),
});

export type DeploymentProviderName = "docker" | "fly";
export type DeploymentConfigByProvider = {
  docker: {
    provider: DeploymentProvider<DockerDeploymentOpts, DockerDeploymentLocator>;
    opts: Omit<DockerDeploymentOpts, "slug">;
  };
  fly: {
    provider: DeploymentProvider<FlyDeploymentOpts, FlyDeploymentLocator>;
    opts: Omit<FlyDeploymentOpts, "slug">;
  };
};
export type DeploymentLocatorByProvider = {
  docker: DockerDeploymentLocator;
  fly: FlyDeploymentLocator;
};
export type AnyDeployment = Deployment;
export type AnyDeploymentConfig = DeploymentConfigByProvider[DeploymentProviderName];
export type AnyDeploymentLocator = DeploymentLocatorByProvider[DeploymentProviderName];

export function parseDeploymentConfig(params: {
  provider: "docker";
  opts: unknown;
}): DeploymentConfigByProvider["docker"];
export function parseDeploymentConfig(params: {
  provider: "fly";
  opts: unknown;
}): DeploymentConfigByProvider["fly"];
export function parseDeploymentConfig(params: {
  provider: DeploymentProviderName;
  opts: unknown;
}): AnyDeploymentConfig;
export function parseDeploymentConfig(params: {
  provider: DeploymentProviderName;
  opts: unknown;
}): AnyDeploymentConfig {
  switch (params.provider) {
    case "docker": {
      const parsed = DockerConfig.parse(params.opts);
      return {
        provider: createDockerProvider(parsed.providerOpts),
        opts: parsed.opts,
      };
    }
    case "fly": {
      const parsed = FlyConfig.parse(params.opts);
      return {
        provider: createFlyProvider(parsed.providerOpts),
        opts: parsed.opts,
      };
    }
  }
}

export function parseDeploymentLocator(params: {
  provider: "docker";
  locator: unknown;
}): DeploymentLocatorByProvider["docker"];
export function parseDeploymentLocator(params: {
  provider: "fly";
  locator: unknown;
}): DeploymentLocatorByProvider["fly"];
export function parseDeploymentLocator(params: {
  provider: DeploymentProviderName;
  locator: unknown;
}): AnyDeploymentLocator;
export function parseDeploymentLocator(params: {
  provider: DeploymentProviderName;
  locator: unknown;
}): AnyDeploymentLocator {
  switch (params.provider) {
    case "docker":
      return dockerProviderManifest.locatorSchema.parse(params.locator);
    case "fly":
      return flyProviderManifest.locatorSchema.parse(params.locator);
  }
}

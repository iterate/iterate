import {
  DockerDeployment,
  FlyDeployment,
  type ProjectDeployment,
  type SandboxFixture,
} from "./deployment.ts";

export type { ProjectDeployment, SandboxFixture };

export interface CreateProjectDeploymentParams {
  image: string;
  name?: string;
  extraHosts?: string[];
  capAdd?: string[];
  env?: Record<string, string> | string[];
}

function resolveProvider(): "docker" | "fly" {
  const provider = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
  if (provider === "docker" || provider === "fly") {
    return provider;
  }
  throw new Error(`Unsupported JONASLAND_E2E_PROVIDER: ${provider}`);
}

function resolveFlyImage(params: CreateProjectDeploymentParams): string {
  if (params.image.trim().length > 0) return params.image;
  const fallback = process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.FLY_DEFAULT_IMAGE;
  if (fallback && fallback.trim().length > 0) return fallback;
  throw new Error("Fly deployment requires image or JONASLAND_E2E_FLY_IMAGE/FLY_DEFAULT_IMAGE");
}

export async function projectDeployment(
  params: CreateProjectDeploymentParams,
): Promise<ProjectDeployment> {
  const provider = resolveProvider();
  if (provider === "fly") {
    const deployment = new FlyDeployment({
      image: resolveFlyImage(params),
      name: params.name,
      env: params.env,
    });
    await deployment.start();
    return deployment;
  }

  const deployment = new DockerDeployment(params);
  await deployment.start();
  return deployment;
}

export const sandboxFixture = projectDeployment;

export type ProjectDeploymentType = "docker" | "fly";
export type ProjectDeploymentMode = "deploy" | "check";

export interface CreateProjectDeploymentOptions {
  mode: ProjectDeploymentMode;
}

export interface ProjectDeploymentHandle<
  TType extends ProjectDeploymentType = ProjectDeploymentType,
> {
  readonly type: TType;
  readonly providerId: string;
  readonly imageTag: string;
  getBaseUrl(): Promise<string>;
  deploy(): Promise<void>;
  check(): Promise<void>;
}

export type ProjectDeploymentProvider<TType extends ProjectDeploymentType = ProjectDeploymentType> =
  (opts: CreateProjectDeploymentOptions) => Promise<ProjectDeploymentHandle<TType>>;

export async function runProjectDeployment<TType extends ProjectDeploymentType>(params: {
  mode: ProjectDeploymentMode;
  provider: ProjectDeploymentProvider<TType>;
  runProof: (input: {
    deployment: ProjectDeploymentHandle<TType>;
    baseUrl: string;
  }) => Promise<void>;
}): Promise<{ deployment: ProjectDeploymentHandle<TType>; baseUrl: string }> {
  const deployment = await params.provider({ mode: params.mode });
  if (params.mode === "deploy") {
    await deployment.deploy();
  }

  await deployment.check();
  const baseUrl = await deployment.getBaseUrl();
  await params.runProof({ deployment, baseUrl });
  return { deployment, baseUrl };
}

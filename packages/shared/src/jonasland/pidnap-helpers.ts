import type { AnyContractRouter } from "@orpc/contract";

export interface ServiceManifestLike<TContract extends AnyContractRouter = AnyContractRouter> {
  slug: string;
  port: number;
  orpcContract: TContract;
}

export interface ServiceManifestWithEntryPoint<
  TContract extends AnyContractRouter = AnyContractRouter,
> extends ServiceManifestLike<TContract> {
  serverEntryPoint: string;
}

export interface PidnapServiceConfig {
  processSlug: string;
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  tags: string[];
  restartImmediately: boolean;
  healthCheck: {
    url: string;
    intervalMs: number;
  };
}

export function localHostForService(params: { slug: string }): string {
  const normalized = params.slug.trim().toLowerCase();
  const base = normalized.endsWith("-service")
    ? normalized.slice(0, -"-service".length)
    : normalized;
  return `${base}.iterate.localhost`;
}

export function serviceManifestToPidnapConfig(params: {
  manifest: ServiceManifestWithEntryPoint;
  env?: Record<string, string>;
}): PidnapServiceConfig;
export function serviceManifestToPidnapConfig(params: {
  manifests: ServiceManifestWithEntryPoint[];
  env?: Record<string, string>;
}): PidnapServiceConfig[];
export function serviceManifestToPidnapConfig(params: {
  manifest?: ServiceManifestWithEntryPoint;
  manifests?: ServiceManifestWithEntryPoint[];
  env?: Record<string, string>;
}): PidnapServiceConfig | PidnapServiceConfig[] {
  if (params.manifests) {
    return params.manifests.map((manifest) =>
      serviceManifestToPidnapConfig({ manifest, env: params.env }),
    );
  }
  const manifest = params.manifest!;
  const host = localHostForService({ slug: manifest.slug });
  return {
    processSlug: manifest.slug,
    definition: {
      command: "tsx",
      args: [manifest.serverEntryPoint],
      env: { PORT: String(manifest.port), ...params.env },
    },
    tags: ["on-demand"],
    restartImmediately: true,
    healthCheck: {
      url: `http://${host}/api/__iterate/health`,
      intervalMs: 2_000,
    },
  };
}

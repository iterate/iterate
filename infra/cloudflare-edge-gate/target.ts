import { envs } from "../../envs.ts";

export type EdgeGateTarget =
  | {
      kind: "production";
      envName: "prd";
      accountId: string;
      zoneNames: string[];
    }
  | {
      kind: "preview";
      envName: `preview_${number}`;
      accountId: string;
      zoneName: string;
    };

export function resolveEdgeGateTarget(options: {
  envName: string | undefined;
  cloudflareAccountId: string | undefined;
}): EdgeGateTarget {
  if (!options.envName) {
    throw new Error("EDGE_GATE_ENV is required (for example prd or preview_7).");
  }
  if (!options.cloudflareAccountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required.");
  }

  const environment = Object.values(envs).find(
    (candidate) => candidate.dopplerConfig === options.envName,
  );
  if (!environment) {
    throw new Error(`Unknown deployed edge-gate environment ${JSON.stringify(options.envName)}.`);
  }
  if (environment.cloudflareAccountId !== options.cloudflareAccountId) {
    throw new Error(
      `EDGE_GATE_ENV ${options.envName} belongs to Cloudflare account ${environment.cloudflareAccountId}, ` +
        `but Doppler selected ${options.cloudflareAccountId}.`,
    );
  }

  if (options.envName === "prd") {
    return {
      kind: "production",
      envName: "prd",
      accountId: environment.cloudflareAccountId,
      zoneNames: [...environment.projectHostnameBases, ...environment.ownedProjectCustomApexes],
    };
  }

  if (!isPreviewEnvName(options.envName) || environment.projectHostnameBases.length !== 1) {
    throw new Error(
      `Edge-gate environment ${JSON.stringify(options.envName)} is not a production or preview target.`,
    );
  }

  return {
    kind: "preview",
    envName: options.envName,
    accountId: environment.cloudflareAccountId,
    zoneName: environment.projectHostnameBases[0],
  };
}

function isPreviewEnvName(value: string): value is `preview_${number}` {
  return /^preview_\d+$/.test(value);
}

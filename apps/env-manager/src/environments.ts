import {
  authEnvs,
  docsEnvs,
  dummyPetshopEnvs,
  envs,
  PREVIEW_AND_DEV_ACCOUNT_ID,
  PRD_ACCOUNT_ID,
  streamsExampleEnvs,
} from "../../../envs.ts";
import { EnvironmentStage } from "./state.ts";

type CloudflareAccount = "preview" | "production";

interface Environment {
  account: CloudflareAccount;
  accountId: string;
  baseUrl: string;
  stage: EnvironmentStage;
  workerNames: string[];
}

export interface PlatformEnvironment extends Environment {
  kind: "platform";
  osWorkerName: string;
}

export interface AuthEnvironment extends Environment {
  kind: "auth";
}

export type CompiledEnvironment = AuthEnvironment | PlatformEnvironment;

function accountFor(accountId: string): CloudflareAccount {
  if (accountId === PRD_ACCOUNT_ID) return "production";
  if (accountId === PREVIEW_AND_DEV_ACCOUNT_ID) return "preview";
  throw new Error(`Unknown Cloudflare account ${accountId} in envs.ts.`);
}

function workerNameFor(
  environments: Record<string, { dopplerConfig: string; workerName: string }>,
  stage: EnvironmentStage,
): string {
  const environment = environments[stage];
  if (environment === undefined) {
    throw new Error(`No Worker is configured for ${stage}.`);
  }
  return environment.workerName;
}

/**
 * The complete environment-manager inventory.
 *
 * Vite compiles these non-secret fields from envs.ts into the Worker and
 * browser bundles. Changing an environment or Worker name therefore requires
 * an env-manager deployment. Destroy an environment before removing its stage
 * from envs.ts: the compiled inventory is the authority needed for teardown.
 */
export const environments = [
  ...Object.values(envs).map((environment) => {
    const stage = EnvironmentStage.parse(environment.dopplerConfig);
    return {
      kind: "platform",
      stage,
      account: accountFor(environment.cloudflareAccountId),
      accountId: environment.cloudflareAccountId,
      baseUrl: environment.baseUrl,
      osWorkerName: environment.osWorkerName,
      workerNames: [
        environment.osWorkerName,
        `${environment.osWorkerName}-typechecker`,
        `${environment.osWorkerName}-worker-bundler`,
        environment.authWorkerName,
        environment.semaphoreWorkerName,
        workerNameFor(docsEnvs, stage),
        workerNameFor(dummyPetshopEnvs, stage),
        workerNameFor(streamsExampleEnvs, stage),
      ],
    } satisfies PlatformEnvironment;
  }),
  {
    kind: "auth",
    stage: EnvironmentStage.parse(authEnvs.dev_global.dopplerConfig),
    account: accountFor(authEnvs.dev_global.cloudflareAccountId),
    accountId: authEnvs.dev_global.cloudflareAccountId,
    baseUrl: authEnvs.dev_global.authBaseUrl,
    workerNames: [authEnvs.dev_global.authWorkerName],
  } satisfies AuthEnvironment,
];

const stages = new Set<string>(environments.map(({ stage }) => stage));

export function isCompiledEnvironmentStage(value: string): value is EnvironmentStage {
  return stages.has(value);
}

export function getEnvironment(stage: EnvironmentStage): CompiledEnvironment {
  const environment = environments.find((candidate) => candidate.stage === stage);
  if (environment === undefined) {
    throw new Error(`Environment ${JSON.stringify(stage)} is not compiled into env-manager.`);
  }
  return environment;
}

import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import {
  createOrpcOpenApiServiceClient,
  createOrpcRpcServiceClient,
  type ServiceClientEnv,
  type ServiceManifestLike,
} from "@jonasland2/shared";
import { nomadRegisterJobFromFileAndWait } from "./fixtures.ts";
import {
  waitForConsulServicePassingBlocking,
  type ConsulHealthServiceEntry,
} from "./consul-fixture.ts";

export type ServiceFixtureTransport = "rpc-http" | "openapi";

export interface StartNomadServiceTypedClientOptions<TContract extends AnyContractRouter> {
  nomadBaseUrl: string;
  consulBaseUrl: string;
  jobFilePath: string | URL;
  manifest: ServiceManifestLike<TContract>;
  serviceName: string;
  jobId?: string;
  taskEnvOverrides?: Record<string, string>;
  timeoutMs?: number;
  transport?: ServiceFixtureTransport;
  clientEnv?: ServiceClientEnv;
  clientHeaders?: Record<string, string>;
}

export interface StartedNomadServiceTypedClient<TContract extends AnyContractRouter> {
  jobId: string;
  serviceName: string;
  consulEntries: ConsulHealthServiceEntry[];
  consulIndex: string;
  client: ContractRouterClient<TContract>;
}

export async function startNomadServiceWithTypedClient<TContract extends AnyContractRouter>(
  options: StartNomadServiceTypedClientOptions<TContract>,
): Promise<StartedNomadServiceTypedClient<TContract>> {
  const timeoutMs = options.timeoutMs ?? 90_000;

  const registered = await nomadRegisterJobFromFileAndWait({
    nomadBaseUrl: options.nomadBaseUrl,
    jobFilePath: options.jobFilePath,
    jobId: options.jobId,
    taskEnvOverrides: options.taskEnvOverrides,
    timeoutMs,
  });

  const consul = await waitForConsulServicePassingBlocking({
    consulBaseUrl: options.consulBaseUrl,
    serviceName: options.serviceName,
    timeoutMs,
  });

  const transport = options.transport ?? "rpc-http";
  const clientEnv = options.clientEnv ?? {};

  const client =
    transport === "openapi"
      ? createOrpcOpenApiServiceClient({
          env: clientEnv,
          manifest: options.manifest,
          ...(options.clientHeaders ? { headers: options.clientHeaders } : {}),
        })
      : createOrpcRpcServiceClient({
          env: clientEnv,
          manifest: options.manifest,
          ...(options.clientHeaders ? { headers: options.clientHeaders } : {}),
        });

  return {
    jobId: registered.jobId,
    serviceName: options.serviceName,
    consulEntries: consul.entries,
    consulIndex: consul.lastConsulIndex,
    client,
  };
}

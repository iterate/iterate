export type OrpcProcedure = "machines.getEnv" | "machines.reportStatus";

export interface OrpcRequest {
  type: "orpc";
  procedure: OrpcProcedure;
  input: unknown;
  timestamp: Date;
}

export interface EgressRequest {
  type: "egress";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: Date;
}

export type RecordedRequest = OrpcRequest | EgressRequest;

export type EgressHandlerResult =
  | Response
  | {
      status?: number;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | unknown;

export type EgressHandler = (
  req: EgressRequest,
) => EgressHandlerResult | Promise<EgressHandlerResult>;

export interface MockIterateOsApi {
  port: number;
  url: string;
  requests: RecordedRequest[];
  orpc: {
    getRequests(procedure: OrpcProcedure): OrpcRequest[];
    setGetEnvResponse(response: { envVars: Record<string, string>; repos: RepoInfo[] }): void;
    setReportStatusResponse(response: { success: boolean }): void;
  };
  egress: {
    getRequests(pathPattern?: string | RegExp): EgressRequest[];
    onRequest(pattern: string | RegExp, handler: EgressHandler): void;
    setSecrets(secrets: Record<string, string>): void;
  };
  resetRequests(): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type RepoInfo = {
  url: string;
  branch: string;
  path: string;
  owner: string;
  name: string;
};

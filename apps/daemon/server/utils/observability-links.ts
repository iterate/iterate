import { Buffer } from "node:buffer";

type SessionLinkEnv = {
  osBaseUrl: string;
  organizationSlug: string;
  projectSlug: string;
  machineId: string;
  customerRepoPath: string;
};

function getSessionLinkEnv(): SessionLinkEnv | null {
  const osBaseUrl = process.env.ITERATE_OS_BASE_URL;
  const organizationSlug = process.env.ITERATE_ORG_SLUG;
  const projectSlug = process.env.ITERATE_PROJECT_SLUG;
  const machineId = process.env.ITERATE_MACHINE_ID;
  const customerRepoPath = process.env.ITERATE_CUSTOMER_REPO_PATH;

  if (!osBaseUrl || !organizationSlug || !projectSlug || !machineId || !customerRepoPath) {
    return null;
  }

  return {
    osBaseUrl,
    organizationSlug,
    projectSlug,
    machineId,
    customerRepoPath,
  };
}

function escapeSingleQuotes(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function buildMachineProxyBase(env: SessionLinkEnv, port: number): string {
  return `${env.osBaseUrl}/org/${env.organizationSlug}/proj/${env.projectSlug}/${env.machineId}/proxy/${port}`;
}

function buildTerminalUrl(command: string): string | undefined {
  const env = getSessionLinkEnv();
  if (!env) return undefined;
  const proxyUrl = buildMachineProxyBase(env, 3000);
  return `${proxyUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
}

export function buildOpencodeAttachUrl(params: {
  sessionId: string;
  workingDirectory?: string;
}): string | undefined {
  const env = getSessionLinkEnv();
  if (!env) return undefined;
  const directory = params.workingDirectory || env.customerRepoPath;
  const command = `opencode attach 'http://localhost:4096' --session ${params.sessionId} --dir ${directory}`;
  return buildTerminalUrl(command);
}

export function buildOpencodeWebSessionUrl(params: {
  sessionId: string;
  workingDirectory?: string;
}): string | undefined {
  const env = getSessionLinkEnv();
  if (!env) return undefined;
  const directory = params.workingDirectory || env.customerRepoPath;
  const encodedDirectory = Buffer.from(directory, "utf8").toString("base64").replace(/=+$/, "");
  const opencodeProxyBase = buildMachineProxyBase(env, 4096);
  return `${opencodeProxyBase}/${encodedDirectory}/session/${params.sessionId}`;
}

export function buildLogsSearchUrl(query: string): string | undefined {
  const escaped = escapeSingleQuotes(query);
  const command =
    "grep -n " +
    `'${escaped}' /var/log/pidnap/process/daemon-backend.log /var/log/pidnap/process/opencode.log`;
  return buildTerminalUrl(command);
}

export function buildJaegerTraceUrl(traceId: string): string | undefined {
  const env = getSessionLinkEnv();
  if (!env) return undefined;
  const jaegerBase = buildMachineProxyBase(env, 16686);
  return `${jaegerBase}/trace/${traceId}`;
}

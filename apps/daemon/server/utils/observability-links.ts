import { Buffer } from "node:buffer";
import { buildProjectPortUrl } from "@iterate-com/shared/project-ingress";

type SessionLinkEnv = {
  projectBaseUrl: string;
  customerRepoPath: string;
};

function getSessionLinkEnv(): SessionLinkEnv | null {
  const projectBaseUrl = process.env.ITERATE_PROJECT_BASE_URL;
  const customerRepoPath = process.env.ITERATE_CUSTOMER_REPO_PATH;

  if (!projectBaseUrl || !customerRepoPath) {
    return null;
  }

  return { projectBaseUrl, customerRepoPath };
}

function escapeSingleQuotes(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function buildTerminalUrl(command: string): string | undefined {
  const env = getSessionLinkEnv();
  if (!env) return undefined;
  const baseUrl = buildProjectPortUrl({ projectBaseUrl: env.projectBaseUrl, port: 3000 });
  return `${baseUrl}terminal?${new URLSearchParams({ command, autorun: "true" })}`;
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
  const encodedDirectory = Buffer.from(directory, "utf8").toString("base64url");
  const opencodeBase = buildProjectPortUrl({ projectBaseUrl: env.projectBaseUrl, port: 4096 });
  return `${opencodeBase}${encodedDirectory}/session/${params.sessionId}`;
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
  const jaegerBase = buildProjectPortUrl({ projectBaseUrl: env.projectBaseUrl, port: 16686 });
  return `${jaegerBase}trace/${traceId}`;
}

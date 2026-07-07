// Slack Web API access for itx.
//
// The project's Slack bot token lives in an itx secret Durable Object
// (`/secrets/integrations/slack/bot-token`). Calls go through the project
// egress door with a `getSecret({ path: ... })` placeholder in the
// authorization header, so token material never leaves the secret DO's
// substitution pipeline and every outbound attempt lands on the secret's
// audit trail. When the project has no connected workspace, the deployment's
// Slack integration `botToken` config is the fallback.

import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import {
  mintProjectFileUrl,
  putProjectFile,
  sanitizeFileFilename,
} from "../files/project-files.ts";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { SLACK_BOT_TOKEN_SECRET_PATH } from "./utils.ts";
import { parseConfig } from "~/config.ts";

type SlackWebApiResult = { error?: string; ok?: boolean } & Record<string, unknown>;

/** Direct Slack Web API call with a literal token (OAuth exchange, fallback token). */
async function callSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  token: string;
}): Promise<SlackWebApiResult> {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  return await parseSlackWebApiResponse(response, input.method);
}

/**
 * Slack Web API call authorized by the project's stored bot token, without
 * ever reading the token material: the request carries a secret reference
 * placeholder and traverses the project egress door, which substitutes it in
 * the secret Durable Object. Falls back to the Slack integration bot token
 * when the project has no stored token.
 */
export async function callProjectSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  projectId: string;
}): Promise<SlackWebApiResult> {
  const placeholder = `getSecret({ path: "${SLACK_BOT_TOKEN_SECRET_PATH}" })`;
  const request = new Request(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${placeholder}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(request);
  if (response.status === 404 || response.status === 400) {
    // secret_not_found / secret_reference errors from the secret pipeline —
    // not a Slack response. Fall back to the deployment-wide bot token.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      const fallbackToken = readFallbackSlackBotToken();
      if (fallbackToken === null) {
        throw new Error(
          `Slack Web API ${input.method} failed: no project Slack bot token secret and no Slack integration botToken config fallback (${errorBody.error}).`,
        );
      }
      return await callSlackWebApi({
        body: input.body,
        method: input.method,
        token: fallbackToken,
      });
    }
  }
  return await parseSlackWebApiResponse(response, input.method);
}

/**
 * Downloads a Slack file's bytes (`url_private`) with the project's bot
 * token — the same secret-placeholder egress path as callProjectSlackWebApi,
 * falling back to the deployment-wide bot token when the project has none.
 * Slack answers unauthorized downloads with a 200 HTML login page, so HTML
 * responses count as auth failures.
 */
async function downloadProjectSlackFile(input: {
  projectId: string;
  url: string;
}): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  const placeholder = `getSecret({ path: "${SLACK_BOT_TOKEN_SECRET_PATH}" })`;
  let response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(
    new Request(input.url, { headers: { authorization: `Bearer ${placeholder}` } }),
  );
  if (!isUsableSlackFileResponse(response)) {
    const fallbackToken = readFallbackSlackBotToken();
    if (fallbackToken !== null) {
      response = await fetch(input.url, {
        headers: { authorization: `Bearer ${fallbackToken}` },
      });
    }
  }
  if (!isUsableSlackFileResponse(response)) {
    throw new Error(`Slack file download failed: HTTP ${response.status}`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function isUsableSlackFileResponse(response: Response): boolean {
  if (!response.ok) return false;
  return !(response.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * Materializes Slack-shared files into project file storage under the
 * agent's path and returns the attachments for the agent input event. Paths
 * derive from the caller's stable `storageKey` (the webhook event offset), so
 * a replayed processor batch overwrites the same objects instead of
 * duplicating them.
 */
export async function storeSlackFilesForAgent(input: {
  agentPath: string;
  files: Array<{ mimetype?: string; name?: string; urlPrivate: string }>;
  projectId: string;
  storageKey: string;
}): Promise<AgentFileAttachment[]> {
  const config = parseConfig(itxEnv);
  return await Promise.all(
    input.files.map(async (file, index): Promise<AgentFileAttachment> => {
      const download = await downloadProjectSlackFile({
        projectId: input.projectId,
        url: file.urlPrivate,
      });
      const filename = sanitizeFileFilename(file.name ?? `slack-file-${index}`);
      const path = `${input.agentPath}/${input.storageKey}-${index}-${filename}`;
      const metadata = await putProjectFile({
        contentType: file.mimetype ?? download.contentType,
        data: download.bytes,
        path,
        projectId: input.projectId,
      });
      const url = await mintProjectFileUrl({ config, path, projectId: input.projectId });
      return {
        contentType: metadata.contentType,
        filename,
        path: metadata.path,
        size: metadata.size,
        url,
      };
    }),
  );
}

function readFallbackSlackBotToken(): string | null {
  try {
    const config = parseConfig(itxEnv);
    const token = config.integrations.slack?.botToken?.exposeSecret();
    return token && token.trim() !== "" ? token : null;
  } catch {
    return null;
  }
}

async function parseSlackWebApiResponse(
  response: Response,
  method: string,
): Promise<SlackWebApiResult> {
  const result = (await response.json().catch(() => null)) as SlackWebApiResult | null;
  if (result === null) {
    throw new Error(`Slack Web API ${method} failed: HTTP ${response.status} (non-JSON body)`);
  }
  if (!response.ok || result.ok === false) {
    const error = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
    throw new Error(`Slack Web API ${method} failed: ${error}`);
  }
  return result;
}

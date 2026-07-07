// Slack Web API access for itx.
//
// Each named Slack connection's bot token lives in an itx secret Durable
// Object (`/secrets/integrations/slack/{connection}/bot-token`). Calls go
// through the project egress door with a `getSecret(path)`
// placeholder in the authorization header, so token material never leaves the
// secret DO's substitution pipeline and every outbound attempt lands on the
// secret's audit trail. There is NO fallback token: a missing secret (typo'd
// connection name, disconnected workspace) fails loudly instead of silently
// posting with someone else's credential.

import { WebClient, type WebClientOptions } from "@slack/web-api";
import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import {
  mintProjectFileUrl,
  putProjectFile,
  sanitizeFileFilename,
} from "../files/project-files.ts";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { slackBotTokenSecretPath } from "./utils.ts";
import { parseConfig } from "~/config.ts";

type SlackWebApiResult = { error?: string; ok?: boolean } & Record<string, unknown>;

type SlackEgressStub = { fetch(request: Request): Promise<Response> };

/**
 * An Axios adapter that sends WebClient's requests through the project egress
 * door instead of axios's Node transport (which doesn't exist at the edge). The
 * bot-token placeholder WebClient puts in the Authorization header is
 * substituted inside the Secret DO, so the real token never enters this isolate
 * and every call lands on the secret's audit trail — the SAME path as the
 * hand-rolled `callProjectSlackWebApi`, but driven by the real SDK.
 */
function slackEgressAdapter(stub: SlackEgressStub): NonNullable<WebClientOptions["adapter"]> {
  return async (config) => {
    const base = (config.baseURL ?? "").replace(/\/$/, "");
    const path = config.url ?? "";
    const url = /^https?:\/\//.test(path) ? path : `${base}/${path.replace(/^\//, "")}`;
    const headers = new Headers();
    const raw =
      typeof config.headers?.toJSON === "function" ? config.headers.toJSON() : config.headers;
    for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      if (value != null && typeof value !== "object") headers.set(key, String(value));
    }
    const method = (config.method ?? "post").toUpperCase();
    const response = await stub.fetch(
      new Request(url, {
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : ((config.data as BodyInit | null | undefined) ?? undefined),
        headers,
        method,
      }),
    );
    const text = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return {
      config,
      data: text ? JSON.parse(text) : {},
      headers: responseHeaders,
      // WebClient reads response.request.path (WebClient.ts) — axios normally
      // sets `request` to a Node ClientRequest; give it the shape it reads.
      request: { path: new URL(url).pathname },
      status: response.status,
      statusText: response.statusText,
    };
  };
}

/**
 * A Slack WebClient for one named connection whose transport rides the project
 * egress door — the bot token stays in its Secret DO (a `getSecret(...)`
 * placeholder in the Authorization header, substituted downstream). The itx
 * caller surface `itx.integrations.slack["<connection>"]` replays the caller's
 * dotted Web API path (chat.postMessage, conversations.list, …) straight onto
 * this instance, so it IS the Slack SDK — no hand-mapped method table.
 */
export function connectionSlackClient(input: { connection: string; projectId: string }): WebClient {
  const placeholder = `getSecret({ path: "${slackBotTokenSecretPath(input.connection)}" })`;
  return new WebClient(placeholder, {
    // Dials the project egress door (not the Secret DO directly, unlike
    // github/gmail) so project egress interceptors observe Slack calls.
    adapter: slackEgressAdapter(projectStub(itxEnv.PROJECT, input.projectId)),
    // The egress door + our own error handling own retries; the SDK's node-retry
    // timers are neither needed nor edge-friendly.
    retryConfig: { retries: 0 },
  });
}

/** How to drive the Slack built-in: a named connection, then a Web API method
 * path replayed onto that connection's WebClient. The single source of truth,
 * shared by the dispatch guard (rpc-targets) and the error normalizer below. */
export const SLACK_CALL_GRAMMAR =
  'itx.integrations.slack expected `<connection>.<Web API method>` (e.g. itx.integrations.slack["main-slack"].chat.postMessage({ channel, text })); use itx.integrations.list() to see connections.';

/** Turn a WebClient failure into a caller-facing Error whose message survives
 * the capnweb boundary. A secret-pipeline error (the connection has no usable
 * bot token) is named so the caller can fix it; a path-resolution miss means
 * the caller drove the WebClient with a shape that is not a Web API method —
 * most often they omitted the connection, so a namespace like `chat` was
 * consumed as the connection name — so point them at the grammar; otherwise
 * keep Slack's error. */
export function normalizeSlackError(error: unknown, connection: string): Error {
  const e = error as { data?: { error?: string }; message?: string };
  const slackError = e.data?.error;
  if (typeof slackError === "string" && slackError.startsWith("secret_")) {
    return new Error(
      `Slack connection "${connection}" has no usable bot token (${slackError}). Use itx.integrations.list() to see connections.`,
    );
  }
  if (typeof e.message === "string" && e.message.includes("did not resolve to a function")) {
    return new Error(SLACK_CALL_GRAMMAR);
  }
  return new Error(e.message ?? String(error));
}

/**
 * Slack Web API call authorized by one named connection's stored bot token,
 * without ever reading the token material: the request carries a secret
 * reference placeholder and traverses the project egress door, which
 * substitutes it in the secret Durable Object.
 */
export async function callProjectSlackWebApi(input: {
  body: Record<string, unknown>;
  connection: string;
  method: string;
  projectId: string;
}): Promise<SlackWebApiResult> {
  const placeholder = `getSecret({ path: "${slackBotTokenSecretPath(input.connection)}" })`;
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
    // not a Slack response. Name the connection so the failure is actionable.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      throw new Error(
        `Slack Web API ${input.method} failed: connection "${input.connection}" has no usable bot token secret (${errorBody.error}). Use itx.integrations.list() to see connections.`,
      );
    }
  }
  return await parseSlackWebApiResponse(response, input.method);
}

/**
 * Downloads a Slack file's bytes (`url_private`) with one named connection's
 * bot token — the same secret-placeholder egress path as
 * callProjectSlackWebApi, and the same no-fallback stance: a missing secret
 * fails loudly instead of silently downloading with someone else's credential.
 * Slack answers unauthorized downloads with a 200 HTML login page, so HTML
 * responses count as auth failures.
 */
async function downloadProjectSlackFile(input: {
  connection: string;
  projectId: string;
  url: string;
}): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  const placeholder = `getSecret({ path: "${slackBotTokenSecretPath(input.connection)}" })`;
  const response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(
    new Request(input.url, { headers: { authorization: `Bearer ${placeholder}` } }),
  );
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
  connection: string;
  files: Array<{ mimetype?: string; name?: string; urlPrivate: string }>;
  projectId: string;
  storageKey: string;
}): Promise<AgentFileAttachment[]> {
  const config = parseConfig(itxEnv);
  return await Promise.all(
    input.files.map(async (file, index): Promise<AgentFileAttachment> => {
      const download = await downloadProjectSlackFile({
        connection: input.connection,
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

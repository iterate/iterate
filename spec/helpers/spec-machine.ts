import { createHmac, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWorkerClient } from "../../apps/daemon/server/orpc/client.ts";
import { buildSpecMachineEmail } from "../../apps/os/backend/email/spec-machine.ts";
import playwrightConfig from "../../playwright.config.ts";

type RequestRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
};

type ThreadMessage = {
  role: string;
  text: string;
};

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function orpcJson(response: ServerResponse, body: unknown) {
  return json(response, 200, { json: body });
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function signSvixMessage(params: { body: string; secret: string; id: string; timestamp: string }) {
  const secretBytes = Buffer.from(params.secret.split("_")[1] ?? "", "base64");
  const signedContent = `${params.id}.${params.timestamp}.${params.body}`;
  const signature = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return `v1,${signature}`;
}

async function getFallbackAppUrl() {
  const { baseURL } = playwrightConfig.use;
  const response = await fetch(baseURL, { method: "GET", redirect: "manual" });
  const redirectLocation = response.headers.get("location");
  if (redirectLocation) {
    return new URL(redirectLocation, baseURL).origin;
  }

  return new URL(baseURL).origin;
}

async function postWithManualRedirect(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) {
  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: params.body,
    redirect: "manual",
  });

  if (response.status < 300 || response.status >= 400) {
    return response;
  }

  const redirectLocation = response.headers.get("location");
  if (!redirectLocation) {
    return response;
  }

  return fetch(new URL(redirectLocation, params.url), {
    method: "POST",
    headers: params.headers,
    body: params.body,
    redirect: "manual",
  });
}

async function parseJsonResponse(response: Response) {
  const responseText = await response.text();
  const contentType = response.headers.get("content-type") ?? "unknown";

  if (!response.ok) {
    throw new Error(
      `Fake resend webhook failed: HTTP ${response.status} ${response.statusText} at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
    );
  }

  if (/<!DOCTYPE|<html/i.test(responseText)) {
    throw new Error(
      `Fake resend webhook returned HTML instead of JSON at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Fake resend webhook returned non-JSON response at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
      { cause: error },
    );
  }
}

function getLocalPostgresPort() {
  const postgresPort = execSync(`tsx ./scripts/docker-compose.ts port postgres 5432`)
    .toString()
    .trim()
    .split(":")
    .at(-1);

  if (!postgresPort) {
    throw new Error("Failed to determine local postgres port for specs");
  }

  return postgresPort;
}

async function archiveOlderMachinePullJobs(cutoff: Date) {
  execSync(
    [
      `psql "postgres://postgres:postgres@127.0.0.1:${getLocalPostgresPort()}/os"`,
      `-c "SELECT pgmq.archive('consumer_job_queue', msg_id) FROM pgmq.q_consumer_job_queue WHERE message->>'consumer_name' = 'triggerMachinePullIterateIterate' AND enqueued_at < '${cutoff.toISOString()}'::timestamptz"`,
    ].join(" "),
  );
}

export type SpecMachine = {
  baseUrl: string;
  senderEmail: string;
  requests: RequestRecord[];
  sendFakeResendWebhook(params: { subject: string; text: string }): Promise<unknown>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function createSpecMachine(): Promise<SpecMachine> {
  const requests: RequestRecord[] = [];
  const threads = new Map<string, ThreadMessage[]>();
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const createdAt = new Date();
  let iterateOsBaseUrl: string | undefined;

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await readRequestBody(request);
    const contentType = request.headers["content-type"] ?? "";
    let parsedJson: unknown;
    if (typeof contentType === "string" && contentType.includes("application/json") && text) {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = undefined;
      }
    }

    requests.push({
      method,
      path: url.pathname,
      headers: Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : value ? [[key, value.join(",")]] : [],
        ),
      ),
      text,
      json: parsedJson,
    });

    if (method === "POST" && ["/__spec-machine/bootstrap", "/bootstrap"].includes(url.pathname)) {
      const body = parsedJson as { envVars: Record<string, string> };
      iterateOsBaseUrl = body.envVars.ITERATE_OS_BASE_URL;
      const previousBaseUrl = process.env.ITERATE_OS_BASE_URL;
      const previousApiKey = process.env.ITERATE_OS_API_KEY;
      const previousMachineId = process.env.ITERATE_MACHINE_ID;

      process.env.ITERATE_OS_BASE_URL = body.envVars.ITERATE_OS_BASE_URL;
      process.env.ITERATE_OS_API_KEY = body.envVars.ITERATE_OS_API_KEY;
      process.env.ITERATE_MACHINE_ID = body.envVars.ITERATE_MACHINE_ID;

      try {
        const client = createWorkerClient();
        await client.machines.reportStatus({
          machineId: body.envVars.ITERATE_MACHINE_ID,
          status: "ready",
        });
      } finally {
        process.env.ITERATE_OS_BASE_URL = previousBaseUrl;
        process.env.ITERATE_OS_API_KEY = previousApiKey;
        process.env.ITERATE_MACHINE_ID = previousMachineId;
      }

      return json(response, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/api/orpc/tool/readFile") {
      const body = parsedJson as { json: { path: string } };
      const content = files.get(body.json.path);
      return orpcJson(response, {
        path: body.json.path,
        content: content ?? null,
        exists: !!content,
      });
    }

    if (method === "POST" && url.pathname === "/api/orpc/tool/writeFile") {
      const body = parsedJson as { json: { path: string; content: string } };
      files.set(body.json.path, body.json.content);
      return orpcJson(response, {
        path: body.json.path,
        bytesWritten: Buffer.byteLength(body.json.content),
      });
    }

    if (method === "POST" && url.pathname === "/api/orpc/tool/execCommand") {
      const body = parsedJson as { json: { command: string[] } };
      const [command, ...args] = body.json.command;

      if (command === "test" && args[0] === "-d") {
        return orpcJson(response, {
          exitCode: directories.has(args[1] ?? "") ? 0 : 1,
          stdout: "",
          stderr: "",
        });
      }

      if (command === "git" && args[0] === "clone") {
        const targetPath = args.at(-1);
        if (targetPath) {
          directories.add(`${targetPath}/.git`);
        }
      }

      return orpcJson(response, { exitCode: 0, stdout: "", stderr: "" });
    }

    if (method === "POST" && url.pathname === "/api/integrations/webchat/webhook") {
      const body = parsedJson as { threadId: string; text: string };
      const messages = threads.get(body.threadId) ?? [];
      messages.push({ role: "user", text: body.text });
      messages.push({ role: "assistant", text: "3" });
      threads.set(body.threadId, messages);
      return json(response, 200, { success: true, threadId: body.threadId });
    }

    if (method === "GET" && url.pathname.startsWith("/api/integrations/webchat/threads/")) {
      const threadId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      return json(response, 200, { threadId, messages: threads.get(threadId) ?? [] });
    }

    if (method === "POST" && url.pathname === "/api/integrations/email/webhook") {
      return json(response, 200, { success: true });
    }

    json(response, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine spec machine address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const senderEmail = buildSpecMachineEmail({ baseUrl });

  const specMachine = {
    baseUrl,
    senderEmail,
    requests,
    server,
    async sendFakeResendWebhook(params: { subject: string; text: string }) {
      await archiveOlderMachinePullJobs(createdAt);

      const appUrl = iterateOsBaseUrl ?? (await getFallbackAppUrl());
      const now = new Date().toISOString();
      const body = JSON.stringify({
        type: "email.received",
        created_at: now,
        data: {
          email_id: `email_${randomUUID()}`,
          created_at: now,
          from: senderEmail,
          to: ["bot@example.com"],
          cc: [],
          bcc: [],
          message_id: `<${randomUUID()}@spec-machine>`,
          subject: params.subject,
          attachments: [],
        },
        _iterate_email_content: {
          text: params.text,
          html: null,
        },
      });

      let secret = process.env.RESEND_BOT_WEBHOOK_SECRET;
      if (!secret) {
        secret = execSync(`doppler secrets get RESEND_BOT_WEBHOOK_SECRET --plain`)
          .toString()
          .trim();
      }
      if (!secret) {
        throw new Error("RESEND_BOT_WEBHOOK_SECRET must be set for fake resend webhooks");
      }

      const id = `msg_${randomUUID()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));

      const headers = {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signSvixMessage({ body, secret, id, timestamp }),
      };

      const response = await postWithManualRedirect({
        url: `${appUrl}/api/integrations/resend/webhook`,
        headers,
        body,
      });

      return parseJsonResponse(response);
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };

  return specMachine;
}

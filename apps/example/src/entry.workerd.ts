import { env as workerEnv } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { drizzle as drizzleWorkerd } from "drizzle-orm/d1";
import crossws from "crossws/adapters/cloudflare";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});
const db = drizzleWorkerd(workerEnv.DB, { schema });
const durableCounterPrefix = "/api/durable-counter";
const sandboxPrefix = "/api/sandbox";
const sandboxId = "example-poc";
const sandboxCwd = "/workspace";
const sandboxStatusPath = `${sandboxCwd}/status.mjs`;
const sandboxUserCodePath = `${sandboxCwd}/user-code.mjs`;
const sandboxStatusCommand = `node ${sandboxStatusPath}`;
const sandboxUserCodeCommand = `node ${sandboxUserCodePath}`;
const sandboxStatusCode = `
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: process.cwd(),
}));
`;

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const url = new URL(request.url);
        if (
          url.pathname === durableCounterPrefix ||
          url.pathname.startsWith(`${durableCounterPrefix}/`)
        ) {
          return env.EXAMPLE_COUNTER.getByName("default").fetch(request);
        }

        if (url.pathname === sandboxPrefix || url.pathname.startsWith(`${sandboxPrefix}/`)) {
          return handleSandboxRequest(request, env);
        }

        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          log,
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};

async function handleSandboxRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const sandbox = getSandbox(env.SANDBOX, sandboxId, {
    normalizeId: true,
    sleepAfter: "2m",
    containerTimeouts: {
      instanceGetTimeoutMS: 60_000,
    },
  });

  try {
    if (request.method === "GET" && url.pathname === sandboxPrefix) {
      await sandbox.writeFile(sandboxStatusPath, sandboxStatusCode);
      const result = await sandbox.exec(sandboxStatusCommand, {
        cwd: sandboxCwd,
        timeout: 10_000,
      });

      return jsonResponse({
        sandboxId,
        status: result.success ? "ready" : "error",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    if (request.method === "POST" && url.pathname === `${sandboxPrefix}/run`) {
      const body = await readJsonObject(request);
      const code = typeof body.code === "string" ? body.code : "";
      if (code.trim().length === 0) {
        return jsonResponse({ error: "JavaScript code is required." }, { status: 400 });
      }
      if (code.length > 20_000) {
        return jsonResponse(
          { error: "JavaScript code must be 20,000 characters or fewer." },
          {
            status: 400,
          },
        );
      }

      const startedAt = Date.now();
      await sandbox.writeFile(sandboxUserCodePath, code);
      const result = await sandbox.exec(sandboxUserCodeCommand, {
        cwd: sandboxCwd,
        env: {
          CI: "1",
          FORCE_COLOR: "0",
        },
        timeout: 10_000,
      });

      return jsonResponse({
        sandboxId,
        command: sandboxUserCodeCommand,
        durationMs: Date.now() - startedAt,
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    if (request.method === "POST" && url.pathname === `${sandboxPrefix}/destroy`) {
      await sandbox.destroy();
      return jsonResponse({
        sandboxId,
        destroyed: true,
      });
    }

    return jsonResponse({ error: "Sandbox endpoint not found." }, { status: 404 });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

async function readJsonObject(request: Request) {
  const parsed = (await request.json().catch(() => null)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

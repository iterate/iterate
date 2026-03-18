import { checkPort, getPort } from "get-port-please";
import { execConcurretly } from "@iterate-com/shared/dev/exec-concurrently";
import { appScriptBase } from "@iterate-com/shared/jonasland";
import { loadEnv } from "vite";
import { z } from "zod";

const DEFAULT_FRONTEND_PORT = 17401;
const DEFAULT_BACKEND_PORT = 17402;

const ServeInput = z.object({
  port: z.coerce.number().int().positive().optional(),
});

async function getDefaultBackendPort() {
  const preferredPort = await checkPort(DEFAULT_BACKEND_PORT, "0.0.0.0");
  if (preferredPort) return preferredPort;
  return await getPort({ port: 0, host: "0.0.0.0" });
}

function getPortFromUrl(urlString: string) {
  const url = new URL(urlString);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

async function runFrontendAndBackend(params: {
  mode: "development" | "production";
  frontendPort?: number;
  viteArgs: string[];
}) {
  const env = loadEnv(params.mode, process.cwd(), "");
  const frontendPort =
    params.frontendPort ??
    (process.env.PORT?.trim()
      ? Number(process.env.PORT)
      : env.PORT?.trim()
        ? Number(env.PORT)
        : await getPort({ port: DEFAULT_FRONTEND_PORT }));
  const apiBaseUrl =
    process.env.API_BASE_URL ||
    env.API_BASE_URL ||
    `http://127.0.0.1:${await getDefaultBackendPort()}`;
  const backendPort = getPortFromUrl(apiBaseUrl);

  console.log(`\nUsing frontend port -> ${frontendPort}`);
  console.log(`Using backend port -> ${backendPort}\n`);

  await execConcurretly({
    commands: [
      [
        "tsx",
        ["src/node/server.ts"],
        {
          nodeOptions: {
            env: { ...process.env, PORT: String(backendPort) },
            stdio: "inherit",
          },
        },
      ],
      [
        "vite",
        [...params.viteArgs, "--host", "0.0.0.0", "--port", String(frontendPort)],
        {
          nodeOptions: {
            env: {
              ...process.env,
              PORT: String(frontendPort),
              API_BASE_URL: apiBaseUrl,
              VITE_API_BASE_URL: apiBaseUrl,
            },
            stdio: "inherit",
          },
        },
      ],
    ],
  });

  return { stopped: true };
}

export const devScript = appScriptBase
  .meta({ description: "Run the example Vite dev server and backend concurrently" })
  .input(ServeInput)
  .handler(async ({ input }) =>
    runFrontendAndBackend({
      mode: "development",
      frontendPort: input.port,
      viteArgs: [],
    }),
  );

export const previewScript = appScriptBase
  .meta({ description: "Run the example Vite preview server and backend concurrently" })
  .input(ServeInput)
  .handler(async ({ input }) =>
    runFrontendAndBackend({
      mode: "production",
      frontendPort: input.port,
      viteArgs: ["preview"],
    }),
  );
